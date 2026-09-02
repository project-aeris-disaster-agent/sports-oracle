-- ============================================================
-- 20250101000013_observability_and_settlement_watch.sql
--
-- Four things this system could not answer before, each of which a customer
-- asked about directly:
--
--   1. Is an upstream actually answering?  Status was derived from quota and
--      entitlement only. TxLINE is unmetered, so when its API token expired the
--      sport kept reporting "online" for two weeks. upstream_health records every
--      upstream outcome; status.ts reads it.
--
--   2. When does a subscription lapse?  TxLINE access is bought in 4-week terms
--      and nothing tracked the end date. provider_subscriptions does, and status
--      degrades ahead of expiry instead of after.
--
--   3. Has an official result ever changed?  Nothing looked twice. Once a result
--      was official it was cached for 30 days and never re-read.
--      settlement_observations is an append-only log of every state transition a
--      settleable event goes through, written by the settlement-watch job, so
--      "did this ever revise" is a query rather than a shrug.
--
--   4. Push.  Webhook subscriptions and a delivery log, dispatched by the same
--      watch job the moment an observation is a transition. No persistent
--      process: pg_cron drives it, exactly like cache-warm.
--
-- Plus status_history, so "99.9% uptime" can one day be a measured number
-- rather than a string on a landing page.
--
-- Idempotent. cron.schedule upserts by name.
-- ============================================================

-- ── 1. Upstream health ──────────────────────────────────────────────────────
create table if not exists upstream_health (
  id           bigserial primary key,
  provider     text not null,
  sport        text not null,
  data_type    text not null,
  ok           boolean not null,
  status       int,
  latency_ms   int,
  error        text,
  observed_at  timestamptz not null default now()
);

create index if not exists idx_upstream_health_recent
  on upstream_health (sport, observed_at desc);
create index if not exists idx_upstream_health_provider
  on upstream_health (provider, observed_at desc);

alter table upstream_health enable row level security;

create or replace function record_upstream_health(
  p_provider text, p_sport text, p_data_type text,
  p_ok boolean, p_status int, p_latency_ms int, p_error text
) returns void
language sql security definer
as $$
  insert into upstream_health (provider, sport, data_type, ok, status, latency_ms, error)
  values (p_provider, p_sport, p_data_type, p_ok, p_status, p_latency_ms, left(p_error, 500));
$$;

-- The question status.ts asks: over the last N minutes, what happened to this
-- sport's upstream calls? One row per sport, cheap enough to run per request.
create or replace function upstream_health_summary(p_minutes int default 30)
returns table (
  sport        text,
  calls        bigint,
  failures     bigint,
  last_ok_at   timestamptz,
  last_fail_at timestamptz,
  last_status  int,
  last_error   text
)
language sql security definer stable
as $$
  with recent as (
    select * from upstream_health
    where observed_at > now() - make_interval(mins => p_minutes)
  ),
  latest as (
    select distinct on (sport) sport, status, error
    from recent order by sport, observed_at desc
  )
  select
    r.sport,
    count(*)                                   as calls,
    count(*) filter (where not r.ok)           as failures,
    max(r.observed_at) filter (where r.ok)     as last_ok_at,
    max(r.observed_at) filter (where not r.ok) as last_fail_at,
    l.status                                   as last_status,
    l.error                                    as last_error
  from recent r
  join latest l using (sport)
  group by r.sport, l.status, l.error;
$$;

-- ── 2. Provider subscriptions ───────────────────────────────────────────────
create table if not exists provider_subscriptions (
  provider       text primary key,
  service_level  int,
  wallet         text,
  activated_at   timestamptz,
  expires_at     timestamptz,
  term_weeks     int,
  note           text,
  updated_at     timestamptz not null default now()
);

alter table provider_subscriptions enable row level security;

-- ── 3. Settlement observations ──────────────────────────────────────────────
-- Append-only. A row is written only when something CHANGED versus the previous
-- row for the same event, so the table is a transition log rather than a
-- heartbeat. `revised` marks the one transition that should never happen: an
-- outcome changing after it was already reported official.
create table if not exists settlement_observations (
  id            bigserial primary key,
  sport         text not null,
  event_id      text not null,
  status        text not null,
  official      boolean not null,
  winner_id     text,
  void_reason   text,
  content_hash  text not null,
  prev_status   text,
  prev_official boolean,
  revised       boolean not null default false,
  source        text,
  resolution    jsonb,
  observed_at   timestamptz not null default now()
);

create index if not exists idx_settlement_obs_event
  on settlement_observations (sport, event_id, observed_at desc);
create index if not exists idx_settlement_obs_cursor
  on settlement_observations (sport, observed_at, id);
create index if not exists idx_settlement_obs_revised
  on settlement_observations (sport, observed_at desc) where revised;

alter table settlement_observations enable row level security;

-- Returns the new observation id when this is a transition, null when it is a
-- no-change heartbeat. Decides `revised` from the previous row, which is the
-- only place that knowledge exists.
create or replace function record_settlement_observation(
  p_sport text, p_event_id text, p_status text, p_official boolean,
  p_winner_id text, p_void_reason text, p_content_hash text,
  p_source text, p_resolution jsonb
) returns bigint
language plpgsql security definer
as $$
declare
  prev record;
  new_id bigint;
  is_revised boolean := false;
begin
  select status, official, winner_id, content_hash
  into prev
  from settlement_observations
  where sport = p_sport and event_id = p_event_id
  order by observed_at desc, id desc
  limit 1;

  if found and prev.content_hash = p_content_hash then
    return null;  -- nothing changed
  end if;

  -- A revision is an official outcome that later reads differently. A
  -- provisional->official transition is NOT a revision; that is the normal path.
  if found and prev.official and (
       p_official = false
    or coalesce(prev.winner_id, '') <> coalesce(p_winner_id, '')
    or prev.status <> p_status
  ) then
    is_revised := true;
  end if;

  insert into settlement_observations (
    sport, event_id, status, official, winner_id, void_reason, content_hash,
    prev_status, prev_official, revised, source, resolution
  ) values (
    p_sport, p_event_id, p_status, p_official, p_winner_id, p_void_reason, p_content_hash,
    prev.status, prev.official, is_revised, p_source, p_resolution
  ) returning id into new_id;

  return new_id;
end;
$$;

-- Events the watch job should look at again: anything observed recently that
-- is not yet official, plus anything that went official inside the revision
-- window (so a post-publication change is caught rather than assumed away).
create or replace function settlement_watchlist(p_sport text, p_revision_days int, p_limit int)
returns table (event_id text, status text, official boolean, last_observed timestamptz)
language sql security definer stable
as $$
  with latest as (
    select distinct on (event_id) event_id, status, official, observed_at
    from settlement_observations
    where sport = p_sport
      and observed_at > now() - make_interval(days => p_revision_days + 2)
    order by event_id, observed_at desc, id desc
  )
  select event_id, status, official, observed_at
  from latest
  where (not official and status in ('live', 'provisional', 'scheduled'))
     or (official and observed_at > now() - make_interval(days => p_revision_days))
  order by official asc, observed_at asc
  limit p_limit;
$$;

-- ── 4. Webhooks ─────────────────────────────────────────────────────────────
create table if not exists webhook_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  api_key_id      uuid references api_keys(id) on delete cascade,
  privy_id        text not null,
  url             text not null,
  secret          text not null,
  sports          text[] not null default '{}',   -- empty = every sport
  events          text[] not null default '{official,void,revised}',
  is_active       boolean not null default true,
  failures        int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_webhook_subs_active
  on webhook_subscriptions (is_active) where is_active;
create index if not exists idx_webhook_subs_privy
  on webhook_subscriptions (privy_id);

alter table webhook_subscriptions enable row level security;

create table if not exists webhook_deliveries (
  id              bigserial primary key,
  subscription_id uuid not null references webhook_subscriptions(id) on delete cascade,
  observation_id  bigint not null references settlement_observations(id) on delete cascade,
  attempt         int not null default 1,
  status          int,
  error           text,
  delivered_at    timestamptz not null default now(),
  unique (subscription_id, observation_id, attempt)
);

create index if not exists idx_webhook_deliveries_retry
  on webhook_deliveries (subscription_id, observation_id, attempt desc);

alter table webhook_deliveries enable row level security;

-- Deliveries that failed and still have attempts left. The watch job retries
-- these before doing anything else, so a subscriber's transient outage does not
-- lose a settlement notification.
create or replace function webhook_retry_queue(p_max_attempts int, p_limit int)
returns table (subscription_id uuid, observation_id bigint, attempts int)
language sql security definer stable
as $$
  with last_attempt as (
    select distinct on (subscription_id, observation_id)
      subscription_id, observation_id, attempt, status
    from webhook_deliveries
    order by subscription_id, observation_id, attempt desc
  )
  select subscription_id, observation_id, attempt
  from last_attempt
  where (status is null or status < 200 or status >= 300)
    and attempt < p_max_attempts
  limit p_limit;
$$;

-- PostgREST cannot express `failures = failures + 1` atomically; this can.
-- A subscription that keeps failing is a signal to the operator, not a reason
-- to stop trying: the retry queue caps attempts per delivery, not per endpoint.
create or replace function increment_webhook_failures(p_id uuid)
returns void language sql security definer
as $$
  update webhook_subscriptions set failures = failures + 1 where id = p_id;
$$;

-- ── 5. Status history ───────────────────────────────────────────────────────
create table if not exists status_history (
  id           bigserial primary key,
  checked_at   timestamptz not null default now(),
  service      text not null,
  operational  int not null,
  limited      int not null,
  offline      int not null,
  sports       jsonb not null
);

create index if not exists idx_status_history_time on status_history (checked_at desc);

alter table status_history enable row level security;

-- ── 6. Quota: a settlement reserve, and a burn-rate projection ──────────────
-- check_budget flipped every sport to cache-only at 90% and refused all fetches
-- from there. The last 10% was "headroom" that nothing could ever spend, so at
-- 90% a market could neither price nor settle. Settlement reads may now enter
-- that reserve (p_allow_reserve = true); pricing reads still stop at 90%.
create or replace function check_budget(p_sport text, p_allow_reserve boolean default false)
returns boolean
language sql security definer stable
as $$
  select case
    when coalesce((select q.metered from sport_quota q where q.sport = p_sport), true) = false
      then true
    else coalesce(
      (select b.calls_made < b.calls_limit
          and (p_allow_reserve or not b.cache_only)
       from sportradar_budget b
       where b.month = to_char(now(), 'YYYY-MM') and b.sport = p_sport
       limit 1),
      true
    )
  end;
$$;

-- The weekly quota check, made continuous. Projects month-end usage from the
-- burn rate so far, so "on pace to exhaust" is visible on day 9 rather than on
-- day 27. status.ts reads projected_pct and degrades a sport that is on pace to
-- run out before the month does.
create or replace view quota_projection as
select
  b.sport,
  b.calls_made,
  b.calls_limit,
  round(b.calls_made::numeric / nullif(b.calls_limit, 0) * 100, 2)                as pct_used,
  extract(day from now())::int                                                     as day_of_month,
  extract(day from (date_trunc('month', now()) + interval '1 month - 1 day'))::int as days_in_month,
  round(
    b.calls_made::numeric
    / greatest(extract(epoch from now() - date_trunc('month', now())) / 86400, 0.25)
    * extract(day from (date_trunc('month', now()) + interval '1 month - 1 day'))
  )::int                                                                            as projected_calls,
  round(
    b.calls_made::numeric
    / greatest(extract(epoch from now() - date_trunc('month', now())) / 86400, 0.25)
    * extract(day from (date_trunc('month', now()) + interval '1 month - 1 day'))
    / nullif(b.calls_limit, 0) * 100
  , 1)                                                                              as projected_pct
from sportradar_budget b
join sport_quota q on q.sport = b.sport
where b.month = to_char(now(), 'YYYY-MM')
  and q.metered
  and b.calls_limit > 0;

-- ── Retention: pure SQL, no runner ──────────────────────────────────────────
select cron.schedule(
  'observability-cleanup',
  '45 3 * * *',
  $job$
    delete from upstream_health where observed_at < now() - interval '14 days';
    delete from webhook_deliveries where delivered_at < now() - interval '30 days';
    delete from status_history where checked_at < now() - interval '400 days';
  $job$
);

-- ── Status snapshot: every 5 minutes ────────────────────────────────────────
select cron.schedule(
  'status-snapshot',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'app_url') || '/api/internal/status-snapshot',
    headers := jsonb_build_object(
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_cron_secret')
    )
  )
  $job$
);

-- ── Settlement watch: every 5 minutes, one async POST per entitled sport ────
-- The route no-ops for a sport with no resolver, so listing every entitled
-- sport is safe and means a newly resolvable sport is watched without a
-- migration.
select cron.schedule(
  'settlement-watch',
  '2-59/5 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'app_url') || '/api/internal/settlement-watch',
    body    := jsonb_build_object('sport', q.sport),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_cron_secret')
    )
  )
  from sport_quota q
  where q.entitled = true
  $job$
);

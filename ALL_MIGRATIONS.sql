-- ============================================================
-- Sports Oracle — FULL SCHEMA (001 + 002 + 003 combined)
-- Paste this whole file into the Supabase SQL Editor and Run.
-- Safe to run more than once (idempotent guards throughout).
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ============================================================
-- 001 — CORE TABLES
-- ============================================================

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  privy_id    text not null unique,
  wallet      text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_users_privy_id on users(privy_id);
create index if not exists idx_users_wallet   on users(lower(wallet));

create table if not exists staker_sessions (
  wallet        text primary key,
  privy_id      text,
  user_id       uuid references users(id) on delete cascade,
  stake_amount  numeric(36, 18) not null default 0,
  tier          text not null default 'none'
                  check (tier in ('none', 'scout', 'analyst', 'oracle')),
  sport_mask    text[] not null default '{}',
  verified_at   timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '5 minutes',
  chain_id      int not null default 8453
);

create index if not exists idx_staker_sessions_expires on staker_sessions(expires_at);
create index if not exists idx_staker_sessions_user    on staker_sessions(user_id);
create index if not exists idx_staker_sessions_privy   on staker_sessions(privy_id);

create table if not exists api_keys (
  id            uuid primary key default gen_random_uuid(),
  privy_id      text,
  user_id       uuid references users(id) on delete cascade,
  wallet        text not null,
  key_hash      text not null unique,
  key_prefix    text not null,
  sport_mask    text[] not null default '{}',
  tier          text not null default 'scout'
                  check (tier in ('scout', 'analyst', 'oracle')),
  is_active     boolean not null default true,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create index if not exists idx_api_keys_user   on api_keys(user_id);
create index if not exists idx_api_keys_privy  on api_keys(privy_id);
create index if not exists idx_api_keys_wallet on api_keys(wallet);
create index if not exists idx_api_keys_active on api_keys(is_active) where is_active = true;
create index if not exists idx_api_keys_hash   on api_keys(key_hash)  where is_active = true;

create table if not exists sports_cache (
  id            uuid primary key default gen_random_uuid(),
  sport         text not null
                  check (sport in (
                    'nhl','nfl','mlb','nba','wnba',
                    'tennis','nascar','nba_gleague','mma'
                  )),
  data_type     text not null,
  cache_key     text not null unique,
  payload       jsonb not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  source        text not null default 'sportradar',
  fetch_ms      int,
  byte_size     int
);

create index if not exists idx_cache_key        on sports_cache(cache_key);
create index if not exists idx_cache_expires    on sports_cache(expires_at);
create index if not exists idx_cache_sport_type on sports_cache(sport, data_type);
create index if not exists idx_cache_sport_exp  on sports_cache(sport, expires_at);

create table if not exists sportradar_budget (
  id            uuid primary key default gen_random_uuid(),
  month         text not null unique,
  calls_made    int not null default 0,
  calls_limit   int not null default 100000,
  last_call_at  timestamptz,
  cache_only    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

insert into sportradar_budget (month)
values (to_char(now(), 'YYYY-MM'))
on conflict (month) do nothing;

create table if not exists usage_log (
  id            uuid primary key default gen_random_uuid(),
  api_key_id    uuid references api_keys(id) on delete set null,
  user_id       uuid references users(id) on delete set null,
  sport         text,
  endpoint      text not null,
  cache_hit     boolean not null default true,
  latency_ms    int,
  status_code   int not null default 200,
  called_at     timestamptz not null default now()
);

create index if not exists idx_usage_key_time  on usage_log(api_key_id, called_at desc);
create index if not exists idx_usage_user_time on usage_log(user_id, called_at desc);
create index if not exists idx_usage_cache_hit on usage_log(cache_hit, called_at desc);
create index if not exists idx_usage_called_at on usage_log(called_at desc);

-- ============================================================
-- 002 — RLS + FUNCTIONS
-- ============================================================

alter table users             enable row level security;
alter table staker_sessions   enable row level security;
alter table api_keys          enable row level security;
alter table sports_cache      enable row level security;
alter table sportradar_budget enable row level security;
alter table usage_log         enable row level security;

drop policy if exists "users: read own"                on users;
drop policy if exists "api_keys: read own"             on api_keys;
drop policy if exists "staker_sessions: read own"      on staker_sessions;
drop policy if exists "sports_cache: authenticated read" on sports_cache;
drop policy if exists "budget: authenticated read"     on sportradar_budget;
drop policy if exists "usage_log: read own"            on usage_log;

create policy "users: read own"
  on users for select
  using (auth.uid()::text = privy_id);

create policy "api_keys: read own"
  on api_keys for select
  using (user_id in (select id from users where privy_id = auth.uid()::text));

create policy "staker_sessions: read own"
  on staker_sessions for select
  using (user_id in (select id from users where privy_id = auth.uid()::text));

create policy "sports_cache: authenticated read"
  on sports_cache for select to authenticated using (true);

create policy "budget: authenticated read"
  on sportradar_budget for select to authenticated using (true);

create policy "usage_log: read own"
  on usage_log for select
  using (user_id in (select id from users where privy_id = auth.uid()::text));

create or replace function verify_api_key(raw_key text)
returns table (
  key_id     uuid,
  user_id    uuid,
  wallet     text,
  tier       text,
  sport_mask text[]
)
language sql security definer stable as $$
  select k.id, k.user_id, k.wallet, k.tier, k.sport_mask
  from api_keys k
  where k.key_hash = encode(digest(raw_key, 'sha256'), 'hex')
    and k.is_active = true
    and k.revoked_at is null
  limit 1;
$$;

create or replace function get_cached(p_cache_key text)
returns jsonb
language sql security definer stable as $$
  select payload from sports_cache
  where cache_key = p_cache_key and expires_at > now()
  limit 1;
$$;

create or replace function upsert_cache(
  p_sport      text,
  p_data_type  text,
  p_cache_key  text,
  p_payload    jsonb,
  p_expires_at timestamptz,
  p_fetch_ms   int default null,
  p_source     text default 'sportradar'
)
returns void
language sql security definer as $$
  insert into sports_cache
    (sport, data_type, cache_key, payload, expires_at, fetch_ms, source, byte_size)
  values (
    p_sport, p_data_type, p_cache_key, p_payload, p_expires_at,
    p_fetch_ms, p_source, octet_length(p_payload::text)
  )
  on conflict (cache_key) do update set
    payload    = excluded.payload,
    fetched_at = now(),
    expires_at = excluded.expires_at,
    fetch_ms   = excluded.fetch_ms,
    source     = excluded.source,
    byte_size  = excluded.byte_size;
$$;

create or replace function increment_budget()
returns boolean
language plpgsql security definer as $$
declare
  current_month text := to_char(now(), 'YYYY-MM');
  new_count     int;
begin
  insert into sportradar_budget (month)
  values (current_month)
  on conflict (month) do nothing;

  update sportradar_budget
  set calls_made   = calls_made + 1,
      last_call_at = now(),
      updated_at   = now(),
      cache_only   = (calls_made + 1) >= (calls_limit * 0.9)
  where month = current_month
    and calls_made < calls_limit
  returning calls_made into new_count;

  return new_count is not null;
end;
$$;

create or replace function check_budget()
returns boolean
language sql security definer stable as $$
  select calls_made < calls_limit and not cache_only
  from sportradar_budget
  where month = to_char(now(), 'YYYY-MM')
  limit 1;
$$;

create or replace function log_request(
  p_api_key_id  uuid,
  p_user_id     uuid,
  p_sport       text,
  p_endpoint    text,
  p_cache_hit   boolean,
  p_latency_ms  int,
  p_status_code int default 200
)
returns void
language sql security definer as $$
  insert into usage_log
    (api_key_id, user_id, sport, endpoint, cache_hit, latency_ms, status_code)
  values
    (p_api_key_id, p_user_id, p_sport, p_endpoint, p_cache_hit, p_latency_ms, p_status_code);
$$;

create or replace function cleanup_expired_cache()
returns int
language plpgsql security definer as $$
declare deleted_count int;
begin
  delete from sports_cache where expires_at < now() - interval '24 hours';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function cleanup_old_usage_logs()
returns int
language plpgsql security definer as $$
declare deleted_count int;
begin
  delete from usage_log where called_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_updated_at  on users;
drop trigger if exists budget_updated_at on sportradar_budget;

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

create trigger budget_updated_at
  before update on sportradar_budget
  for each row execute function update_updated_at();

-- ============================================================
-- 003 — VIEWS + SPORT CONFIG
-- ============================================================

create or replace view cache_health as
select
  sport, data_type,
  count(*)                                    as entry_count,
  sum(byte_size)                              as total_bytes,
  min(expires_at)                             as earliest_expiry,
  max(fetched_at)                             as last_fetched,
  count(*) filter (where expires_at > now())  as fresh_count,
  count(*) filter (where expires_at <= now()) as stale_count,
  round(count(*) filter (where expires_at > now())::numeric
        / nullif(count(*), 0) * 100, 1)       as fresh_pct
from sports_cache
group by sport, data_type
order by sport, data_type;

create or replace view usage_summary as
select
  k.id as key_id, k.key_prefix, k.user_id, k.tier, k.sport_mask,
  count(u.id) as total_requests,
  count(u.id) filter (where u.called_at > now() - interval '1 day')   as requests_today,
  count(u.id) filter (where u.called_at > now() - interval '30 days') as requests_month,
  round(avg(u.latency_ms) filter (where u.called_at > now() - interval '1 day')) as avg_latency_ms_today,
  round(count(u.id) filter (where u.cache_hit = true and u.called_at > now() - interval '1 day')::numeric
        / nullif(count(u.id) filter (where u.called_at > now() - interval '1 day'), 0) * 100, 1) as cache_hit_rate_today,
  max(u.called_at) as last_request_at
from api_keys k
left join usage_log u on u.api_key_id = k.id
where k.is_active = true
group by k.id, k.key_prefix, k.user_id, k.tier, k.sport_mask;

create or replace view budget_status as
select
  month, calls_made, calls_limit,
  calls_limit - calls_made                          as calls_remaining,
  round(calls_made::numeric / calls_limit * 100, 1) as pct_used,
  cache_only, last_call_at
from sportradar_budget
where month = to_char(now(), 'YYYY-MM');

create table if not exists sport_config (
  sport         text not null,
  data_type     text not null,
  ttl_seconds   int not null,
  warm_cron     text,
  live_eligible boolean not null default false,
  notes         text,
  primary key (sport, data_type)
);

insert into sport_config (sport, data_type, ttl_seconds, warm_cron, live_eligible, notes) values
('nhl','schedule',604800,'0 6 * * 1',false,'Weekly Monday'),
('nhl','standings',86400,'0 8 * * *',false,'Daily'),
('nhl','roster',604800,'0 6 * * 1',false,'Weekly'),
('nhl','scores',3600,'0 */6 * * *',false,'Every 6h'),
('nhl','live',30,null,true,'Game window only'),
('nfl','schedule',604800,'0 6 * * 1',false,'Weekly'),
('nfl','standings',86400,'0 8 * * *',false,'Daily'),
('nfl','roster',604800,'0 6 * * 2',false,'Weekly Tuesday'),
('nfl','scores',3600,'0 */6 * * *',false,'Every 6h'),
('nfl','live',45,null,true,'Game day only'),
('mlb','schedule',604800,'0 6 * * 1',false,'Weekly'),
('mlb','standings',86400,'0 8 * * *',false,'Daily'),
('mlb','roster',86400,'0 7 * * *',false,'Daily'),
('mlb','scores',3600,'0 */4 * * *',false,'Every 4h'),
('mlb','live',30,null,true,'Game window'),
('mlb','lineups',3600,'0 10,14 * * *',false,'Twice daily'),
('nba','schedule',604800,'0 6 * * 1',false,'Weekly'),
('nba','standings',86400,'0 8 * * *',false,'Daily'),
('nba','roster',604800,'0 6 * * 2',false,'Weekly'),
('nba','scores',3600,'0 */6 * * *',false,'Every 6h'),
('nba','live',20,null,true,'Fastest refresh'),
('wnba','schedule',604800,'0 6 * * 1',false,'Weekly'),
('wnba','standings',86400,'0 8 * * *',false,'Daily'),
('wnba','roster',604800,'0 6 * * 2',false,'Weekly'),
('wnba','scores',3600,'0 */6 * * *',false,'Every 6h'),
('wnba','live',30,null,true,'On-demand'),
('tennis','schedule',604800,'0 6 * * 1',false,'Weekly draws'),
('tennis','rankings',604800,'0 6 * * 1',false,'Weekly ATP/WTA'),
('tennis','results',3600,'0 */3 * * *',false,'Every 3h'),
('tennis','live',60,null,true,'Match window'),
('nascar','schedule',604800,'0 6 * * 1',false,'Weekly'),
('nascar','standings',86400,'0 8 * * 1',false,'Weekly post-race'),
('nascar','entries',86400,'0 8 * * 4',false,'Thursday entry lists'),
('nascar','live',60,null,true,'Race window'),
('nba_gleague','schedule',604800,'0 6 * * 1',false,'Weekly'),
('nba_gleague','standings',86400,'0 8 * * *',false,'Daily'),
('nba_gleague','roster',604800,'0 6 * * 2',false,'Weekly'),
('nba_gleague','scores',3600,'0 */6 * * *',false,'Every 6h'),
('nba_gleague','live',30,null,true,'On-demand'),
('mma','schedule',604800,'0 6 * * 1',false,'Weekly calendar'),
('mma','fighters',604800,'0 6 * * 1',false,'Weekly'),
('mma','events',86400,'0 8 * * *',false,'Daily fight week'),
('mma','results',3600,'0 */6 * * 6,0',false,'Every 6h Sat-Sun'),
('mma','live',120,null,true,'Event night only')
on conflict (sport, data_type) do update set
  ttl_seconds   = excluded.ttl_seconds,
  warm_cron     = excluded.warm_cron,
  live_eligible = excluded.live_eligible,
  notes         = excluded.notes;

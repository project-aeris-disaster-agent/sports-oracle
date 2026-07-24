-- ============================================================
-- 002_rls_and_functions.sql
-- Row-level security + server-side helper functions
-- Run order: 2 of 3
-- ============================================================

alter table users              enable row level security;
alter table staker_sessions    enable row level security;
alter table api_keys           enable row level security;
alter table sports_cache       enable row level security;
alter table sportradar_budget  enable row level security;
alter table usage_log          enable row level security;

create policy "users: read own"
  on users for select
  using (auth.uid()::text = privy_id);

create policy "api_keys: read own"
  on api_keys for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

create policy "staker_sessions: read own"
  on staker_sessions for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

create policy "sports_cache: authenticated read"
  on sports_cache for select
  to authenticated
  using (true);

create policy "budget: authenticated read"
  on sportradar_budget for select
  to authenticated
  using (true);

create policy "usage_log: read own"
  on usage_log for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

create or replace function verify_api_key(raw_key text)
returns table (
  key_id      uuid,
  user_id     uuid,
  wallet      text,
  tier        text,
  sport_mask  text[]
)
language sql
security definer
stable
as $$
  select
    k.id,
    k.user_id,
    k.wallet,
    k.tier,
    k.sport_mask
  from api_keys k
  where k.key_hash = encode(digest(raw_key, 'sha256'), 'hex')
    and k.is_active = true
    and k.revoked_at is null
  limit 1;
$$;

create or replace function get_cached(p_cache_key text)
returns jsonb
language sql
security definer
stable
as $$
  select payload
  from sports_cache
  where cache_key = p_cache_key
    and expires_at > now()
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
language sql
security definer
as $$
  insert into sports_cache
    (sport, data_type, cache_key, payload, expires_at, fetch_ms, source, byte_size)
  values (
    p_sport, p_data_type, p_cache_key, p_payload, p_expires_at,
    p_fetch_ms, p_source, octet_length(p_payload::text)
  )
  on conflict (cache_key) do update set
    payload     = excluded.payload,
    fetched_at  = now(),
    expires_at  = excluded.expires_at,
    fetch_ms    = excluded.fetch_ms,
    source      = excluded.source,
    byte_size   = excluded.byte_size;
$$;

create or replace function increment_budget()
returns boolean
language plpgsql
security definer
as $$
declare
  current_month text := to_char(now(), 'YYYY-MM');
  new_count     int;
begin
  insert into sportradar_budget (month)
  values (current_month)
  on conflict (month) do nothing;

  update sportradar_budget
  set
    calls_made   = calls_made + 1,
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
language sql
security definer
stable
as $$
  select
    calls_made < calls_limit and not cache_only
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
language sql
security definer
as $$
  insert into usage_log
    (api_key_id, user_id, sport, endpoint, cache_hit, latency_ms, status_code)
  values
    (p_api_key_id, p_user_id, p_sport, p_endpoint, p_cache_hit, p_latency_ms, p_status_code);
$$;

create or replace function cleanup_expired_cache()
returns int
language plpgsql
security definer
as $$
declare
  deleted_count int;
begin
  delete from sports_cache
  where expires_at < now() - interval '24 hours';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function cleanup_old_usage_logs()
returns int
language plpgsql
security definer
as $$
declare
  deleted_count int;
begin
  delete from usage_log
  where called_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

create trigger budget_updated_at
  before update on sportradar_budget
  for each row execute function update_updated_at();

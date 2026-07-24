-- ============================================================
-- 002_rls_and_functions.sql
-- Row-level security + server-side helper functions
-- Run order: 2 of 3
-- ============================================================

-- ============================================================
-- ROW LEVEL SECURITY
-- All tables locked down. API routes use the service_role key
-- (server-side only, never exposed to client). Frontend uses
-- anon key with RLS — users can only see their own data.
-- ============================================================

alter table users              enable row level security;
alter table staker_sessions    enable row level security;
alter table api_keys           enable row level security;
alter table sports_cache       enable row level security;
alter table sportradar_budget  enable row level security;
alter table usage_log          enable row level security;

-- ---- users ----
-- Users can read their own row only.
create policy "users: read own"
  on users for select
  using (auth.uid()::text = privy_id);

-- Insert handled server-side (service_role), not by client.

-- ---- api_keys ----
-- Users can read their own keys (to show in dashboard).
create policy "api_keys: read own"
  on api_keys for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

-- ---- staker_sessions ----
-- Users can read their own session to show tier/access in UI.
create policy "staker_sessions: read own"
  on staker_sessions for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

-- ---- sports_cache ----
-- Anyone authenticated can read cache (access enforced at API layer by sport_mask).
create policy "sports_cache: authenticated read"
  on sports_cache for select
  to authenticated
  using (true);

-- ---- sportradar_budget ----
-- Read-only for authenticated users (shown in internal dashboard).
create policy "budget: authenticated read"
  on sportradar_budget for select
  to authenticated
  using (true);

-- ---- usage_log ----
-- Users can read their own usage logs for the dashboard.
create policy "usage_log: read own"
  on usage_log for select
  using (
    user_id in (
      select id from users where privy_id = auth.uid()::text
    )
  );

-- ============================================================
-- FUNCTION: verify_api_key(raw_key text)
-- Called by the API gateway middleware on every request.
-- Returns key metadata if valid, null if invalid/inactive.
-- Uses service_role — never called client-side.
-- ============================================================
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

-- ============================================================
-- FUNCTION: get_cached(p_cache_key text)
-- Returns cached payload if not expired, null if stale.
-- ============================================================
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

-- ============================================================
-- FUNCTION: upsert_cache(...)
-- Inserts or updates a cache entry.
-- ============================================================
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
    p_sport,
    p_data_type,
    p_cache_key,
    p_payload,
    p_expires_at,
    p_fetch_ms,
    p_source,
    octet_length(p_payload::text)
  )
  on conflict (cache_key) do update set
    payload     = excluded.payload,
    fetched_at  = now(),
    expires_at  = excluded.expires_at,
    fetch_ms    = excluded.fetch_ms,
    source      = excluded.source,
    byte_size   = excluded.byte_size;
$$;

-- ============================================================
-- FUNCTION: increment_budget()
-- Atomically increments the current month's Sportradar call
-- counter. Flips cache_only to true at 90K calls.
-- Returns false if budget is exhausted (>= 100K).
-- ============================================================
create or replace function increment_budget()
returns boolean
language plpgsql
security definer
as $$
declare
  current_month text := to_char(now(), 'YYYY-MM');
  new_count     int;
begin
  -- Ensure row exists for this month
  insert into sportradar_budget (month)
  values (current_month)
  on conflict (month) do nothing;

  -- Atomic increment
  update sportradar_budget
  set
    calls_made   = calls_made + 1,
    last_call_at = now(),
    updated_at   = now(),
    cache_only   = (calls_made + 1) >= (calls_limit * 0.9)
  where month = current_month
    and calls_made < calls_limit  -- hard stop at 100K
  returning calls_made into new_count;

  -- If update matched nothing, budget is full
  return new_count is not null;
end;
$$;

-- ============================================================
-- FUNCTION: check_budget()
-- Returns true if we can still make Sportradar calls.
-- ============================================================
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

-- ============================================================
-- FUNCTION: log_request(...)
-- Fire-and-forget usage logging. Called after response sent.
-- ============================================================
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

-- ============================================================
-- FUNCTION: cleanup_expired_cache()
-- Deletes cache entries expired more than 24h ago.
-- Called by GitHub Actions daily cleanup job.
-- ============================================================
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

-- ============================================================
-- FUNCTION: update_updated_at()
-- Trigger function to auto-update updated_at columns.
-- ============================================================
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

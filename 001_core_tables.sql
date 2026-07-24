-- ============================================================
-- 001_core_tables.sql
-- Sports Oracle — core schema
-- Run order: 1 of 3
-- ============================================================

-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ============================================================
-- USERS
-- Created on first Privy login. wallet may be null if user
-- signed up via email and hasn't connected a wallet yet.
-- ============================================================
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  privy_id    text not null unique,
  wallet      text,                        -- Base wallet address, lowercase
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_users_privy_id on users(privy_id);
create index idx_users_wallet   on users(lower(wallet));

-- ============================================================
-- STAKER SESSIONS
-- One row per wallet. Updated on every on-chain re-verify.
-- expires_at = verified_at + 5 minutes (set in application).
-- chain_id 8453 = Base mainnet.
-- ============================================================
create table if not exists staker_sessions (
  wallet        text primary key,           -- lowercase Base address
  user_id       uuid references users(id) on delete cascade,
  stake_amount  numeric(36, 18) not null default 0,
  tier          text not null default 'none'
                  check (tier in ('none', 'scout', 'analyst', 'oracle')),
  sport_mask    text[] not null default '{}',
  verified_at   timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '5 minutes',
  chain_id      int not null default 8453
);

create index idx_staker_sessions_expires on staker_sessions(expires_at);
create index idx_staker_sessions_user    on staker_sessions(user_id);

-- ============================================================
-- API KEYS
-- key_hash  = sha256 of the raw key (never store raw).
-- key_prefix = first 12 chars of raw key, shown in dashboard
--              so users can identify which key is which.
-- sport_mask = ['nhl','nfl','mlb',...] — sports this key can access.
-- ============================================================
create table if not exists api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  wallet        text not null,
  key_hash      text not null unique,
  key_prefix    text not null,              -- e.g. "sk_live_xK9m"
  sport_mask    text[] not null default '{}',
  tier          text not null default 'scout'
                  check (tier in ('scout', 'analyst', 'oracle')),
  is_active     boolean not null default true,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create index idx_api_keys_user      on api_keys(user_id);
create index idx_api_keys_wallet    on api_keys(wallet);
create index idx_api_keys_active    on api_keys(is_active) where is_active = true;
-- Fast lookup on every inbound request:
create index idx_api_keys_hash      on api_keys(key_hash) where is_active = true;

-- ============================================================
-- SPORTS CACHE
-- One row per discrete cached resource.
-- cache_key pattern: {sport}:{data_type}:{qualifier}
--   e.g.  nhl:scores:2025-01-15
--         nfl:schedule:2024-season
--         nba:roster:team:BOS
--         mma:events:upcoming
-- payload = raw Sportradar JSON response (no transformation).
-- source: 'sportradar' | 'manual' | 'seed'
-- ============================================================
create table if not exists sports_cache (
  id            uuid primary key default gen_random_uuid(),
  sport         text not null
                  check (sport in (
                    'nhl','nfl','mlb','nba','wnba',
                    'tennis','nascar','nba_gleague','mma'
                  )),
  data_type     text not null,              -- 'scores','schedule','roster','standings','live','events'
  cache_key     text not null unique,
  payload       jsonb not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  source        text not null default 'sportradar',
  fetch_ms      int,                        -- how long the Sportradar call took
  byte_size     int                         -- payload size for storage tracking
);

-- Primary lookup: exact key
create index idx_cache_key          on sports_cache(cache_key);
-- Expiry sweeps (cleanup job)
create index idx_cache_expires      on sports_cache(expires_at);
-- Dashboard queries: "show me all NHL data"
create index idx_cache_sport_type   on sports_cache(sport, data_type);
-- Find stale entries per sport for the warm-up job
create index idx_cache_sport_exp    on sports_cache(sport, expires_at);

-- ============================================================
-- SPORTRADAR BUDGET
-- One row per calendar month. Tracks API credit consumption.
-- The dispatcher reads this before every Sportradar call.
-- If calls_made >= calls_limit * 0.9 → cache-only mode.
-- ============================================================
create table if not exists sportradar_budget (
  id            uuid primary key default gen_random_uuid(),
  month         text not null unique,       -- 'YYYY-MM', e.g. '2025-01'
  calls_made    int not null default 0,
  calls_limit   int not null default 100000,
  last_call_at  timestamptz,
  cache_only    boolean not null default false,  -- flipped at 90% usage
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Seed current month on migration
insert into sportradar_budget (month)
values (to_char(now(), 'YYYY-MM'))
on conflict (month) do nothing;

-- ============================================================
-- USAGE LOG
-- One row per API request. Used for dashboards and abuse detection.
-- Keep 90 days of history then archive/delete.
-- cache_hit = true means Sportradar was NOT called.
-- ============================================================
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

-- Dashboard: usage by key over time
create index idx_usage_key_time     on usage_log(api_key_id, called_at desc);
-- Abuse detection: requests per user per window
create index idx_usage_user_time    on usage_log(user_id, called_at desc);
-- Cache hit rate reporting
create index idx_usage_cache_hit    on usage_log(cache_hit, called_at desc);
-- Partition candidate: drop rows older than 90 days
create index idx_usage_called_at    on usage_log(called_at desc);

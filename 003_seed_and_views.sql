-- ============================================================
-- 003_seed_and_views.sql
-- Reference data, convenience views, and maintenance config
-- Run order: 3 of 3
-- ============================================================

-- ============================================================
-- VIEW: cache_health
-- Used by the internal dashboard to show cache freshness.
-- ============================================================
create or replace view cache_health as
select
  sport,
  data_type,
  count(*)                                          as entry_count,
  sum(byte_size)                                    as total_bytes,
  min(expires_at)                                   as earliest_expiry,
  max(fetched_at)                                   as last_fetched,
  count(*) filter (where expires_at > now())        as fresh_count,
  count(*) filter (where expires_at <= now())       as stale_count,
  round(
    count(*) filter (where expires_at > now())::numeric
    / nullif(count(*), 0) * 100, 1
  )                                                 as fresh_pct
from sports_cache
group by sport, data_type
order by sport, data_type;

-- ============================================================
-- VIEW: usage_summary
-- Per-key usage stats for the user dashboard.
-- ============================================================
create or replace view usage_summary as
select
  k.id                                              as key_id,
  k.key_prefix,
  k.user_id,
  k.tier,
  k.sport_mask,
  count(u.id)                                       as total_requests,
  count(u.id) filter (where u.called_at > now() - interval '1 day')   as requests_today,
  count(u.id) filter (where u.called_at > now() - interval '30 days') as requests_month,
  round(
    avg(u.latency_ms) filter (where u.called_at > now() - interval '1 day')
  )                                                 as avg_latency_ms_today,
  round(
    count(u.id) filter (where u.cache_hit = true and u.called_at > now() - interval '1 day')::numeric
    / nullif(count(u.id) filter (where u.called_at > now() - interval '1 day'), 0) * 100, 1
  )                                                 as cache_hit_rate_today,
  max(u.called_at)                                  as last_request_at
from api_keys k
left join usage_log u on u.api_key_id = k.id
where k.is_active = true
group by k.id, k.key_prefix, k.user_id, k.tier, k.sport_mask;

-- ============================================================
-- VIEW: budget_status
-- Quick read for the dispatcher to check budget state.
-- ============================================================
create or replace view budget_status as
select
  month,
  calls_made,
  calls_limit,
  calls_limit - calls_made                          as calls_remaining,
  round(calls_made::numeric / calls_limit * 100, 1) as pct_used,
  cache_only,
  last_call_at
from sportradar_budget
where month = to_char(now(), 'YYYY-MM');

-- ============================================================
-- REFERENCE: sport config
-- Defines TTLs and data types per sport.
-- Application reads this to know how long to cache each type.
-- stored as a simple reference table — not enforced by FK.
-- ============================================================
create table if not exists sport_config (
  sport           text not null,
  data_type       text not null,
  ttl_seconds     int not null,           -- how long this data is considered fresh
  warm_cron       text,                   -- cron expression for GitHub Actions warm job
  live_eligible   boolean not null default false,
  notes           text,
  primary key (sport, data_type)
);

insert into sport_config (sport, data_type, ttl_seconds, warm_cron, live_eligible, notes) values
-- NHL
('nhl', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly on Monday'),
('nhl', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nhl', 'roster',     604800, '0 6 * * 1',    false, 'Weekly'),
('nhl', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h, non-live'),
('nhl', 'live',       30,     null,            true,  'On-demand only during game window'),

-- NFL
('nfl', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('nfl', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nfl', 'roster',     604800, '0 6 * * 2',    false, 'Weekly Tuesday (post-waiver)'),
('nfl', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h'),
('nfl', 'live',       45,     null,            true,  'Game day only'),

-- MLB
('mlb', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('mlb', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('mlb', 'roster',     86400,  '0 7 * * *',    false, 'Daily — rosters change frequently'),
('mlb', 'scores',     3600,   '0 */4 * * *',  false, 'Every 4h during season'),
('mlb', 'live',       30,     null,            true,  'On-demand during game window'),
('mlb', 'lineups',    3600,   '0 10,14 * * *', false, 'Twice daily — lineups post ~1h before game'),

-- NBA
('nba', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('nba', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nba', 'roster',     604800, '0 6 * * 2',    false, 'Weekly'),
('nba', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h'),
('nba', 'live',       20,     null,            true,  'Fastest refresh — high scoring'),

-- WNBA
('wnba', 'schedule',  604800, '0 6 * * 1',    false, 'Weekly'),
('wnba', 'standings', 86400,  '0 8 * * *',    false, 'Daily'),
('wnba', 'roster',    604800, '0 6 * * 2',    false, 'Weekly'),
('wnba', 'scores',    3600,   '0 */6 * * *',  false, 'Every 6h'),
('wnba', 'live',      30,     null,            true,  'On-demand'),

-- Tennis
('tennis', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly — tournament draws'),
('tennis', 'rankings',  604800, '0 6 * * 1',   false, 'Weekly — ATP/WTA update Mondays'),
('tennis', 'results',   3600,   '0 */3 * * *', false, 'Every 3h during tournament'),
('tennis', 'live',      60,     null,           true,  'Match-window only'),

-- NASCAR
('nascar', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly'),
('nascar', 'standings', 86400,  '0 8 * * 1',   false, 'Weekly — updates post-race'),
('nascar', 'entries',   86400,  '0 8 * * 4',   false, 'Thursday — entry lists released'),
('nascar', 'live',      60,     null,           true,  'Race window only — very infrequent'),

-- NBA G League
('nba_gleague', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly'),
('nba_gleague', 'standings', 86400,  '0 8 * * *',   false, 'Daily'),
('nba_gleague', 'roster',    604800, '0 6 * * 2',   false, 'Weekly'),
('nba_gleague', 'scores',    3600,   '0 */6 * * *', false, 'Every 6h'),
('nba_gleague', 'live',      30,     null,           true,  'On-demand'),

-- MMA
('mma', 'schedule',   604800, '0 6 * * 1',   false, 'Weekly — event calendar'),
('mma', 'fighters',   604800, '0 6 * * 1',   false, 'Weekly — records rarely change'),
('mma', 'events',     86400,  '0 8 * * *',   false, 'Daily during fight week'),
('mma', 'results',    3600,   '0 */6 * * 6,0', false, 'Every 6h Sat-Sun (fight nights)'),
('mma', 'live',       120,    null,            true,  'Event night only — between bouts')

on conflict (sport, data_type) do update set
  ttl_seconds   = excluded.ttl_seconds,
  warm_cron     = excluded.warm_cron,
  live_eligible = excluded.live_eligible,
  notes         = excluded.notes;

-- ============================================================
-- CLEANUP: auto-delete usage logs older than 90 days
-- Postgres doesn't have built-in TTL but we can schedule this
-- via GitHub Actions calling the cleanup function weekly.
-- ============================================================
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

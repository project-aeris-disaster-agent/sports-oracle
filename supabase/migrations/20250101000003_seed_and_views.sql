-- ============================================================
-- 003_seed_and_views.sql
-- Reference data, convenience views, and maintenance config
-- Run order: 3 of 3
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
  round(avg(u.latency_ms) filter (where u.called_at > now() - interval '1 day'))
                                                    as avg_latency_ms_today,
  round(
    count(u.id) filter (where u.cache_hit = true and u.called_at > now() - interval '1 day')::numeric
    / nullif(count(u.id) filter (where u.called_at > now() - interval '1 day'), 0) * 100, 1
  )                                                 as cache_hit_rate_today,
  max(u.called_at)                                  as last_request_at
from api_keys k
left join usage_log u on u.api_key_id = k.id
where k.is_active = true
group by k.id, k.key_prefix, k.user_id, k.tier, k.sport_mask;

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

create table if not exists sport_config (
  sport           text not null,
  data_type       text not null,
  ttl_seconds     int not null,
  warm_cron       text,
  live_eligible   boolean not null default false,
  notes           text,
  primary key (sport, data_type)
);

insert into sport_config (sport, data_type, ttl_seconds, warm_cron, live_eligible, notes) values
('nhl', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly on Monday'),
('nhl', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nhl', 'roster',     604800, '0 6 * * 1',    false, 'Weekly'),
('nhl', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h, non-live'),
('nhl', 'live',       30,     null,            true,  'On-demand only during game window'),
('nfl', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('nfl', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nfl', 'roster',     604800, '0 6 * * 2',    false, 'Weekly Tuesday (post-waiver)'),
('nfl', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h'),
('nfl', 'live',       45,     null,            true,  'Game day only'),
('mlb', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('mlb', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('mlb', 'roster',     86400,  '0 7 * * *',    false, 'Daily'),
('mlb', 'scores',     3600,   '0 */4 * * *',  false, 'Every 4h during season'),
('mlb', 'live',       30,     null,            true,  'On-demand during game window'),
('mlb', 'lineups',    3600,   '0 10,14 * * *', false, 'Twice daily'),
('nba', 'schedule',   604800, '0 6 * * 1',    false, 'Weekly'),
('nba', 'standings',  86400,  '0 8 * * *',    false, 'Daily'),
('nba', 'roster',     604800, '0 6 * * 2',    false, 'Weekly'),
('nba', 'scores',     3600,   '0 */6 * * *',  false, 'Every 6h'),
('nba', 'live',       20,     null,            true,  'Fastest refresh'),
('wnba', 'schedule',  604800, '0 6 * * 1',    false, 'Weekly'),
('wnba', 'standings', 86400,  '0 8 * * *',    false, 'Daily'),
('wnba', 'roster',    604800, '0 6 * * 2',    false, 'Weekly'),
('wnba', 'scores',    3600,   '0 */6 * * *',  false, 'Every 6h'),
('wnba', 'live',      30,     null,            true,  'On-demand'),
('tennis', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly'),
('tennis', 'rankings',  604800, '0 6 * * 1',   false, 'Weekly ATP/WTA update'),
('tennis', 'results',   3600,   '0 */3 * * *', false, 'Every 3h during tournament'),
('tennis', 'live',      60,     null,           true,  'Match-window only'),
('nascar', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly'),
('nascar', 'standings', 86400,  '0 8 * * 1',   false, 'Weekly post-race'),
('nascar', 'entries',   86400,  '0 8 * * 4',   false, 'Thursday entry lists'),
('nascar', 'live',      60,     null,           true,  'Race window only'),
('nba_gleague', 'schedule',  604800, '0 6 * * 1',   false, 'Weekly'),
('nba_gleague', 'standings', 86400,  '0 8 * * *',   false, 'Daily'),
('nba_gleague', 'roster',    604800, '0 6 * * 2',   false, 'Weekly'),
('nba_gleague', 'scores',    3600,   '0 */6 * * *', false, 'Every 6h'),
('nba_gleague', 'live',      30,     null,           true,  'On-demand'),
('mma', 'schedule',   604800, '0 6 * * 1',   false, 'Weekly'),
('mma', 'fighters',   604800, '0 6 * * 1',   false, 'Weekly'),
('mma', 'events',     86400,  '0 8 * * *',   false, 'Daily during fight week'),
('mma', 'results',    3600,   '0 */6 * * 6,0', false, 'Every 6h Sat-Sun'),
('mma', 'live',       120,    null,            true,  'Event night only')

on conflict (sport, data_type) do update set
  ttl_seconds   = excluded.ttl_seconds,
  warm_cron     = excluded.warm_cron,
  live_eligible = excluded.live_eligible,
  notes         = excluded.notes;

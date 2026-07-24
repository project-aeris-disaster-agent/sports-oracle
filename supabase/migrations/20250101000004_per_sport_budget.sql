-- ============================================================
-- 20250101000004_per_sport_budget.sql
--
-- Sportradar quota is provisioned PER SPORT, not as one shared pool:
--   tennis 300k · nhl 235k · mlb 225k · nba 110k · nfl 100k
--   gleague 75k · wnba 55k · nascar 2.5k · mma 2.5k   = 1,105,000/mo
--
-- The original single-row model capped everything at a global 100,000, which
-- would have stopped all nine sports at ~9% of real capacity — and would have
-- let a cheap sport (mma, 2.5k) burn quota belonging to an expensive one.
-- Budget is now tracked per (month, sport) with its own limit.
-- ============================================================

-- ── Restructure the budget table ────────────────────────────────────────────
alter table sportradar_budget add column if not exists sport text;

-- Old uniqueness was on month alone; it must now be (month, sport).
alter table sportradar_budget drop constraint if exists sportradar_budget_month_key;
delete from sportradar_budget where sport is null;
alter table sportradar_budget alter column sport set not null;

create unique index if not exists idx_budget_month_sport
  on sportradar_budget(month, sport);

-- ── Per-sport monthly quotas ────────────────────────────────────────────────
create table if not exists sport_quota (
  sport        text primary key,
  monthly_limit int  not null,
  qps           int  not null default 25,
  entitled     boolean not null default true,
  notes        text
);

insert into sport_quota (sport, monthly_limit, qps, entitled, notes) values
  ('tennis',      300000, 25, true,  'Acceleradar'),
  ('nhl',         235000, 25, true,  'Acceleradar'),
  ('mlb',         225000, 25, true,  'Acceleradar'),
  ('nba',         110000, 25, true,  'Acceleradar'),
  ('nfl',         100000, 25, true,  'Production'),
  ('nba_gleague',  75000, 25, false, 'Provisioned but returns 403 - package not active'),
  ('wnba',         55000, 25, true,  'Acceleradar'),
  ('nascar',        2500, 25, false, 'Provisioned but returns 403 - package not active'),
  ('mma',           2500, 25, true,  'Acceleradar - v2 API only, v7 forbidden')
on conflict (sport) do update set
  monthly_limit = excluded.monthly_limit,
  qps           = excluded.qps,
  entitled      = excluded.entitled,
  notes         = excluded.notes;

-- Seed the current month for every sport.
insert into sportradar_budget (month, sport, calls_made, calls_limit)
select to_char(now(), 'YYYY-MM'), q.sport, 0, q.monthly_limit
from sport_quota q
on conflict (month, sport) do nothing;

-- ── check_budget(sport) ─────────────────────────────────────────────────────
drop function if exists check_budget();
drop function if exists check_budget(text);

create or replace function check_budget(p_sport text)
returns boolean
language sql security definer stable
as $$
  select coalesce(
    (select b.calls_made < b.calls_limit and not b.cache_only
     from sportradar_budget b
     where b.month = to_char(now(), 'YYYY-MM') and b.sport = p_sport
     limit 1),
    -- No row yet for this sport/month: allow, increment_budget will create it.
    true
  );
$$;

-- ── increment_budget(sport) ─────────────────────────────────────────────────
drop function if exists increment_budget();
drop function if exists increment_budget(text);

create or replace function increment_budget(p_sport text)
returns boolean
language plpgsql security definer
as $$
declare
  current_month text := to_char(now(), 'YYYY-MM');
  sport_limit   int;
  new_count     int;
begin
  select monthly_limit into sport_limit from sport_quota where sport = p_sport;
  if sport_limit is null then
    sport_limit := 100000;  -- unknown sport: conservative default
  end if;

  insert into sportradar_budget (month, sport, calls_limit)
  values (current_month, p_sport, sport_limit)
  on conflict (month, sport) do nothing;

  update sportradar_budget
  set calls_made   = calls_made + 1,
      last_call_at = now(),
      updated_at   = now(),
      -- Flip to cache-only at 90% so there is headroom before the hard stop.
      cache_only   = (calls_made + 1) >= (calls_limit * 0.9)
  where month = current_month
    and sport = p_sport
    and calls_made < calls_limit
  returning calls_made into new_count;

  return new_count is not null;
end;
$$;

-- ── budget_status view, now per sport ───────────────────────────────────────
drop view if exists budget_status;

create or replace view budget_status as
select
  b.month,
  b.sport,
  b.calls_made,
  b.calls_limit,
  b.calls_limit - b.calls_made                          as calls_remaining,
  round(b.calls_made::numeric / nullif(b.calls_limit,0) * 100, 2) as pct_used,
  b.cache_only,
  q.entitled,
  b.last_call_at
from sportradar_budget b
left join sport_quota q on q.sport = b.sport
where b.month = to_char(now(), 'YYYY-MM')
order by b.calls_limit desc;

-- ============================================================
-- 20250101000008_provider_registry.sql
--
-- Numbered 0008, after the tiers/hardening/suspend chain (0005-0007). It was
-- briefly written as 0005 and collided with 20250101000005_tiers_and_commitments;
-- two files sharing a version prefix makes the apply order undefined. There is no
-- semantic overlap — that chain touches api_keys and stake_commitments, this one
-- touches sports_cache, sport_quota and the budget functions — so running last is
-- safe.
--
-- Makes sports data rather than schema.
--
-- sports_cache.sport carried an inline CHECK listing the nine Sportradar sports.
-- That constraint meant every new sport required a migration — the single hardest
-- blocker to adding open-source providers. Sport identity now lives in the
-- application routing table (src/lib/providers/index.ts); the database stores
-- whatever it is handed.
--
-- Also introduces `metered`, so free providers (OpenF1, Jolpica) stop being
-- charged against a Sportradar quota they do not consume.
-- ============================================================

-- ── Drop the sport whitelist ────────────────────────────────────────────────
-- Inline column CHECKs are auto-named {table}_{column}_check. Dropped by that
-- name, then defensively by any other check constraint on the column, so this
-- is safe on databases where the constraint was created differently.
alter table sports_cache drop constraint if exists sports_cache_sport_check;

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where rel.relname = 'sports_cache'
      and ns.nspname  = 'public'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%sport%'
  loop
    execute format('alter table sports_cache drop constraint %I', c.conname);
  end loop;
end $$;

-- ── Metered flag ────────────────────────────────────────────────────────────
-- An unmetered sport draws on no paid quota. check_budget short-circuits for it
-- so a free provider costs zero Supabase round-trips to authorise.
alter table sport_quota add column if not exists metered  boolean not null default true;
alter table sport_quota add column if not exists provider text    not null default 'sportradar';

-- ── F1 via the open providers ───────────────────────────────────────────────
-- monthly_limit is 0 and meaningless while metered = false; it exists only so
-- the budget_status view has a row to report against.
insert into sport_quota (sport, monthly_limit, qps, entitled, metered, provider, notes) values
  ('f1', 0, 4, true, false, 'jolpica+openf1',
   'Jolpica-F1 (authoritative classification) + OpenF1 (provisional live). Free, keyless. '
   'qps is intentionally low - Jolpica is volunteer-run infrastructure, do not hammer it.')
on conflict (sport) do update set
  monthly_limit = excluded.monthly_limit,
  qps           = excluded.qps,
  entitled      = excluded.entitled,
  metered       = excluded.metered,
  provider      = excluded.provider,
  notes         = excluded.notes;

-- Existing sports keep their Sportradar provenance.
update sport_quota set provider = 'sportradar', metered = true where sport <> 'f1';

-- Seed the current month so budget_status reports F1 alongside everything else.
insert into sportradar_budget (month, sport, calls_made, calls_limit)
select to_char(now(), 'YYYY-MM'), q.sport, 0, q.monthly_limit
from sport_quota q
on conflict (month, sport) do nothing;

-- Reset ledgers for unmetered sports.
-- Before `metered` existed, increment_budget fell back to a 100,000 default for
-- any sport with no sport_quota row, so a free provider silently accrued usage
-- against a quota that does not exist. Those rows would otherwise keep reporting
-- a phantom limit on the dashboard forever.
update sportradar_budget b
set calls_made  = 0,
    calls_limit = q.monthly_limit,
    cache_only  = false,
    updated_at  = now()
from sport_quota q
where q.sport = b.sport
  and q.metered = false;

-- ── Backfill sport_mask so existing keys can reach F1 ───────────────────────
-- sport_mask is stamped at key creation, so keys minted before F1 existed would
-- 403 at the gateway even though the sport is live and free. Keys are only
-- widened if they already hold the full pre-F1 entitled set — a deliberately
-- narrowed key stays narrow.
update api_keys
set sport_mask = array_append(sport_mask, 'f1')
where not (sport_mask @> array['f1'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

-- Same for any live staker session, which is where a re-issued key reads its mask.
update staker_sessions
set sport_mask = array_append(sport_mask, 'f1')
where sport_mask is not null
  and not (sport_mask @> array['f1'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

-- ── check_budget: short-circuit unmetered sports ────────────────────────────
-- The application already skips this RPC for unmetered providers. This is the
-- second line of defence, for the warm cron and anything else calling directly.
create or replace function check_budget(p_sport text)
returns boolean
language sql security definer stable
as $$
  select case
    when coalesce((select q.metered from sport_quota q where q.sport = p_sport), true) = false
      then true
    else coalesce(
      (select b.calls_made < b.calls_limit and not b.cache_only
       from sportradar_budget b
       where b.month = to_char(now(), 'YYYY-MM') and b.sport = p_sport
       limit 1),
      -- No row yet for this sport/month: allow, increment_budget will create it.
      true
    )
  end;
$$;

-- ── increment_budget: never draw down an unmetered sport ────────────────────
create or replace function increment_budget(p_sport text)
returns boolean
language plpgsql security definer
as $$
declare
  current_month text := to_char(now(), 'YYYY-MM');
  sport_limit   int;
  is_metered    boolean;
  new_count     int;
begin
  select q.monthly_limit, q.metered into sport_limit, is_metered
  from sport_quota q where q.sport = p_sport;

  -- Unmetered: nothing to spend. Report success without touching the ledger.
  if is_metered = false then
    return true;
  end if;

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

-- ── budget_status: carry provider + metered through ─────────────────────────
drop view if exists budget_status;

create or replace view budget_status as
select
  b.month,
  b.sport,
  b.calls_made,
  b.calls_limit,
  b.calls_limit - b.calls_made                                   as calls_remaining,
  round(b.calls_made::numeric / nullif(b.calls_limit,0) * 100, 2) as pct_used,
  b.cache_only,
  q.entitled,
  q.metered,
  q.provider,
  b.last_call_at
from sportradar_budget b
left join sport_quota q on q.sport = b.sport
where b.month = to_char(now(), 'YYYY-MM')
order by b.calls_limit desc;

-- ============================================================
-- 20250101000011_agentfighter.sql
--
-- Registers Agent Fighter under the esports vertical.
--
-- SEED ONLY — no schema change, inherited from 0008 (which dropped the
-- sports_cache sport whitelist and moved sport identity into the application
-- routing table, src/lib/providers/index.ts). Adding a sport touches no DDL.
--
-- The sport_quota row is strictly optional: the provider is unmetered, so
-- upstream.ts short-circuits check_budget/increment_budget entirely and the
-- sport would serve correctly without it. It exists so budget_status and the
-- operator dashboard enumerate every sport the router knows about rather than
-- silently omitting the free ones — same reasoning as 0009 and 0010.
-- ============================================================

insert into sport_quota (sport, monthly_limit, qps, entitled, metered, provider, notes) values
  ('agentfighter', 0, 60, true, false, 'agentfighter',
   'Agent Fighter Results API. Free, unauthenticated, CORS-open; published terms are '
   '"Open access. Attribution appreciated, not required." — an explicit permission to '
   'reuse, which is why it is registered license=open and may serve paid tiers rather '
   'than being capped at the free tier like an unclear-terms source. '
   'AUTHORITATIVE on two grounds: the operator is the governing body for its own game, '
   'and the winner is derived by re-simulating the full match input ledger on a '
   'deterministic engine rather than being reported by a participant — the published '
   'state_hash lets a counterparty verify it independently. '
   'Settlement gates on resolution.settlement (final | void | provisional) with NO '
   'confirmation window, unlike dota2: the upstream states the settled/unsettled '
   'distinction directly instead of leaving it to be inferred from elapsed time. '
   'qps is a self-imposed courtesy limit — the upstream publishes no hard rate limit '
   'and asks only that callers honour Cache-Control.')
on conflict (sport) do update set
  monthly_limit = excluded.monthly_limit,
  qps           = excluded.qps,
  entitled      = excluded.entitled,
  metered       = excluded.metered,
  provider      = excluded.provider,
  notes         = excluded.notes;

-- Seed the current month so budget_status reports it alongside everything else.
insert into sportradar_budget (month, sport, calls_made, calls_limit)
select to_char(now(), 'YYYY-MM'), q.sport, 0, q.monthly_limit
from sport_quota q
on conflict (month, sport) do nothing;

-- Keep unmetered ledgers at zero (see 0008 for why these can drift).
update sportradar_budget b
set calls_made  = 0,
    calls_limit = q.monthly_limit,
    cache_only  = false,
    updated_at  = now()
from sport_quota q
where q.sport = b.sport
  and q.metered = false;

-- ── Grant agentfighter to existing keys ─────────────────────────────────────
-- Same conservative rule as the soccer backfill in 0009 and the dota2 backfill
-- in 0010: only widen keys that already hold the full entitled set, so a
-- deliberately narrowed key stays narrow.
update api_keys
set sport_mask = array_append(sport_mask, 'agentfighter')
where not (sport_mask @> array['agentfighter'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

update staker_sessions
set sport_mask = array_append(sport_mask, 'agentfighter')
where sport_mask is not null
  and not (sport_mask @> array['agentfighter'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

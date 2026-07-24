-- ============================================================
-- 20250101000009_soccer_and_alternates.sql
--
-- Registers the sports added by the router expansion.
--
-- Strictly speaking this is optional: unmetered providers never call
-- check_budget or increment_budget (upstream.ts short-circuits on
-- provider.metered), so soccer would serve correctly with no row here. It exists
-- so budget_status and the operator dashboard list every sport the router
-- answers, rather than silently omitting the free ones.
--
-- Adding a sport still needs no schema change — that property survived.
-- ============================================================

insert into sport_quota (sport, monthly_limit, qps, entitled, metered, provider, notes) values
  ('soccer', 0, 60, true, false, 'txline',
   'TxLINE by TxODDS. Solana-anchored, Merkle-verifiable fixtures/odds/scores. '
   'Current entitlement is the World Cup + international Friendlies tier; domestic '
   'league depth requires a higher subscription.'),

  ('football', 0, 30, false, false, 'openligadb',
   'OpenLigaDB - German football (Bundesliga, DFB-Pokal). Registered but OFFLINE: '
   'endpoint paths unverified and no resolution mapper written yet.')
on conflict (sport) do update set
  monthly_limit = excluded.monthly_limit,
  qps           = excluded.qps,
  entitled      = excluded.entitled,
  metered       = excluded.metered,
  provider      = excluded.provider,
  notes         = excluded.notes;

-- Seed the current month so budget_status reports them alongside everything else.
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

-- ── Grant soccer to existing keys ───────────────────────────────────────────
-- Same conservative rule as the F1 backfill in 0008: only widen keys that
-- already hold the full entitled set, so a deliberately narrowed key stays
-- narrow. `football` is deliberately NOT granted — it is offline.
update api_keys
set sport_mask = array_append(sport_mask, 'soccer')
where not (sport_mask @> array['soccer'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

update staker_sessions
set sport_mask = array_append(sport_mask, 'soccer')
where sport_mask is not null
  and not (sport_mask @> array['soccer'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

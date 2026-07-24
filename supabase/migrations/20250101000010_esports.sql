-- ============================================================
-- 20250101000010_esports.sql
--
-- Registers the esports vertical.
--
-- SEED ONLY — no schema change. That property is inherited from 0008, which
-- dropped the sports_cache sport whitelist and moved sport identity into the
-- application routing table (src/lib/providers/index.ts). Adding fourteen sports
-- therefore touches no DDL at all.
--
-- Strictly speaking the sport_quota rows are optional too: every esports provider
-- is unmetered, so upstream.ts short-circuits check_budget/increment_budget and
-- dota2 would serve correctly with no row here. They exist so budget_status and
-- the operator dashboard enumerate every sport the router knows about rather than
-- silently omitting the free ones — the same reasoning as 0009.
-- ============================================================

insert into sport_quota (sport, monthly_limit, qps, entitled, metered, provider, notes) values
  -- ── Serving ────────────────────────────────────────────────────────────────
  ('dota2', 0, 50, true, false, 'opendota',
   'OpenDota (MIT). The only esports title with an open, redistributable, match-level '
   'feed. radiant_win originates in the Valve WebAPI, which is what makes it settleable. '
   'Results are held provisional for 6h before going official — replays can be '
   're-parsed and technical remakes exist. qps reflects OpenDota''s 60/min free tier '
   'with headroom.'),

  -- ── Publisher-locked (Riot) ────────────────────────────────────────────────
  ('lol', 0, 0, false, false, 'riot',
   'OFFLINE, publisher-locked. Riot does not issue production keys for redistribution '
   'services and pro match results are not on the public developer API. No open '
   'alternative. Not expected to change.'),
  ('valorant', 0, 0, false, false, 'riot',
   'OFFLINE, publisher-locked. Same Riot policy as lol.'),
  ('tft', 0, 0, false, false, 'riot',
   'OFFLINE, publisher-locked. Same Riot policy as lol.'),

  -- ── Wiki-only titles ───────────────────────────────────────────────────────
  -- All blocked on the same finding: Liquipedia tournament wikitext carries prize
  -- structure but no team attribution, so placements are not parseable from it.
  -- See src/lib/providers/liquipedia.ts for the pages that were probed.
  ('cs2', 0, 0, false, false, 'liquipedia',
   'OFFLINE. No publisher API permits redistribution; Liquipedia is the only candidate '
   'source and carries no parseable placement-to-team data.'),
  ('starcraft2', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements.'),
  ('rocketleague', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements.'),
  ('overwatch', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements.'),
  ('rainbow6', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements.'),
  ('cod', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Activision withdrew its public API. Liquipedia-only, no parseable placements.'),
  ('mlbb', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Moonton has no public API. Liquipedia-only, no parseable placements.'),

  -- ── Battle royale ──────────────────────────────────────────────────────────
  -- The format is NOT the blocker: placement + kill points already fits the
  -- resolution contract (position = placement, points = score). The source is.
  ('apex', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements. Battle royale format is already '
   'supported by the resolution contract — the source is the blocker, not the shape.'),
  ('pubg', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements. Battle royale.'),
  ('fortnite', 0, 0, false, false, 'liquipedia',
   'OFFLINE. Liquipedia-only, no parseable placements. Battle royale.')
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

-- ── Grant dota2 to existing keys ────────────────────────────────────────────
-- Same conservative rule as the soccer backfill in 0009: only widen keys that
-- already hold the full entitled set, so a deliberately narrowed key stays narrow.
--
-- ONLY dota2 is granted. The thirteen offline titles are deliberately withheld —
-- identical to how `football` was handled in 0009. Granting a mask entry for a
-- sport that cannot serve would make /api/v1/lol fail at the upstream with a 503
-- instead of at the gateway with a 403 naming the reason, which is strictly worse
-- for the caller and burns a request to say nothing.
update api_keys
set sport_mask = array_append(sport_mask, 'dota2')
where not (sport_mask @> array['dota2'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

update staker_sessions
set sport_mask = array_append(sport_mask, 'dota2')
where sport_mask is not null
  and not (sport_mask @> array['dota2'])
  and sport_mask @> array['nba','nhl','nfl','mlb','wnba','tennis','mma'];

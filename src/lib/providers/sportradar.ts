// src/lib/providers/sportradar.ts
// Sportradar as a Provider. The endpoint map is carried over verbatim from the
// original src/lib/sportradar.ts — every path was verified against the live API
// on 2026-07-24 and none of them changed in this refactor.
//
// Entitlement note: this API key returns 403 for NASCAR, NBA G League, and all
// Odds Comparison products. Those maps are retained but will fail until the
// account is upgraded — see SPORT_ENTITLED.

import type { Provider } from './types'

const ENDPOINTS: Record<string, string> = {
  // Keys are namespaced `{sport}:{dataType}` because one Provider now serves
  // every Sportradar sport. Resolution happens in providers/index.ts.

  // ── NBA ──────────────────────────────────────────────────────────────────
  'nba:schedule':     '/nba/trial/v8/en/games/{season}/REG/schedule.json',
  'nba:daily':        '/nba/trial/v8/en/games/{year}/{month}/{day}/schedule.json',
  'nba:scores':       '/nba/trial/v8/en/games/{year}/{month}/{day}/schedule.json',
  'nba:standings':    '/nba/trial/v8/en/seasons/{season}/REG/standings.json',
  'nba:roster':       '/nba/trial/v8/en/teams/{team_id}/profile.json',
  'nba:live':         '/nba/trial/v8/en/games/{game_id}/boxscore.json',
  'nba:injuries':     '/nba/trial/v8/en/league/injuries.json',
  'nba:leaders':      '/nba/trial/v8/en/seasons/{season}/REG/leaders.json',
  'nba:rankings':     '/nba/trial/v8/en/seasons/{season}/REG/rankings.json',
  'nba:teams':        '/nba/trial/v8/en/league/hierarchy.json',
  'nba:pbp':          '/nba/trial/v8/en/games/{game_id}/pbp.json',
  'nba:summary':      '/nba/trial/v8/en/games/{game_id}/summary.json',
  'nba:team_stats':   '/nba/trial/v8/en/seasons/{season}/REG/teams/{team_id}/statistics.json',
  // Sportradar calls the transaction feed "transfers" on NBA/NHL/WNBA and
  // "transactions" on NFL/MLB. Same document either way, so both map to the
  // `transfers` dataType and callers see one endpoint name.
  'nba:transfers':    '/nba/trial/v8/en/league/{year}/{month}/{day}/transfers.json',
  'nba:free_agents':  '/nba/trial/v8/en/league/free_agents.json',
  'nba:changes':      '/nba/trial/v8/en/league/{year}/{month}/{day}/changes.json',

  // ── NHL ──────────────────────────────────────────────────────────────────
  'nhl:schedule':     '/nhl/trial/v7/en/games/{season}/REG/schedule.json',
  'nhl:daily':        '/nhl/trial/v7/en/games/{year}/{month}/{day}/schedule.json',
  'nhl:scores':       '/nhl/trial/v7/en/games/{year}/{month}/{day}/schedule.json',
  'nhl:standings':    '/nhl/trial/v7/en/seasons/{season}/REG/standings.json',
  'nhl:roster':       '/nhl/trial/v7/en/teams/{team_id}/profile.json',
  'nhl:live':         '/nhl/trial/v7/en/games/{game_id}/boxscore.json',
  'nhl:injuries':     '/nhl/trial/v7/en/league/injuries.json',
  'nhl:leaders':      '/nhl/trial/v7/en/seasons/{season}/REG/leaders.json',
  'nhl:teams':        '/nhl/trial/v7/en/league/hierarchy.json',
  'nhl:pbp':          '/nhl/trial/v7/en/games/{game_id}/pbp.json',
  'nhl:summary':      '/nhl/trial/v7/en/games/{game_id}/summary.json',
  'nhl:transfers':    '/nhl/trial/v7/en/league/{year}/{month}/{day}/transfers.json',
  'nhl:free_agents':  '/nhl/trial/v7/en/league/free_agents.json',
  'nhl:changes':      '/nhl/trial/v7/en/league/{year}/{month}/{day}/changes.json',

  // ── NFL ──────────────────────────────────────────────────────────────────
  'nfl:schedule':     '/nfl/official/trial/v7/en/games/{season}/REG/schedule.json',
  'nfl:standings':    '/nfl/official/trial/v7/en/seasons/{season}/REG/standings/season.json',
  'nfl:roster':       '/nfl/official/trial/v7/en/teams/{team_id}/full_roster.json',
  'nfl:live':         '/nfl/official/trial/v7/en/games/{game_id}/boxscore.json',
  // NFL injuries/depth charts are WEEK-scoped — {week} required
  'nfl:injuries':     '/nfl/official/trial/v7/en/seasons/{season}/REG/{week}/injuries.json',
  'nfl:depth_charts': '/nfl/official/trial/v7/en/seasons/{season}/REG/{week}/depth_charts.json',
  'nfl:teams':        '/nfl/official/trial/v7/en/league/hierarchy.json',
  'nfl:pbp':          '/nfl/official/trial/v7/en/games/{game_id}/pbp.json',
  // No `nfl:summary`. The NFL v7 feed has no summary.json: the path that used to
  // sit here returned 404 on every call (verified live 2026-09-02, the only
  // non-200 in a full probe of this map). Game state and scoring come from
  // boxscore.json, which `nfl:live` already maps.
  'nfl:transfers':    '/nfl/official/trial/v7/en/league/{year}/{month}/{day}/transactions.json',
  'nfl:free_agents':  '/nfl/official/trial/v7/en/league/free_agents.json',
  'nfl:changes':      '/nfl/official/trial/v7/en/league/{year}/{month}/{day}/changes.json',

  // ── MLB ──────────────────────────────────────────────────────────────────
  'mlb:schedule':      '/mlb/trial/v7/en/games/{season}/REG/schedule.json',
  'mlb:daily':         '/mlb/trial/v7/en/games/{year}/{month}/{day}/schedule.json',
  'mlb:scores':        '/mlb/trial/v7/en/games/{year}/{month}/{day}/boxscore.json',
  'mlb:standings':     '/mlb/trial/v7/en/seasons/{season}/REG/standings.json',
  'mlb:roster':        '/mlb/trial/v7/en/teams/{team_id}/profile.json',
  'mlb:live':          '/mlb/trial/v7/en/games/{game_id}/summary.json',
  'mlb:injuries':      '/mlb/trial/v7/en/league/injuries.json',
  'mlb:teams':         '/mlb/trial/v7/en/league/hierarchy.json',
  'mlb:pbp':           '/mlb/trial/v7/en/games/{game_id}/pbp.json',
  'mlb:summary':       '/mlb/trial/v7/en/games/{game_id}/summary.json',
  'mlb:daily_summary': '/mlb/trial/v7/en/games/{year}/{month}/{day}/summary.json',
  'mlb:transfers':     '/mlb/trial/v7/en/league/{year}/{month}/{day}/transactions.json',
  'mlb:free_agents':   '/mlb/trial/v7/en/league/free_agents.json',
  'mlb:changes':       '/mlb/trial/v7/en/league/{year}/{month}/{day}/changes.json',

  // ── WNBA ─────────────────────────────────────────────────────────────────
  'wnba:schedule':     '/wnba/trial/v7/en/games/{season}/REG/schedule.json',
  'wnba:daily':        '/wnba/trial/v7/en/games/{year}/{month}/{day}/schedule.json',
  'wnba:scores':       '/wnba/trial/v7/en/games/{year}/{month}/{day}/schedule.json',
  'wnba:standings':    '/wnba/trial/v7/en/seasons/{season}/REG/standings.json',
  'wnba:roster':       '/wnba/trial/v7/en/teams/{team_id}/profile.json',
  'wnba:live':         '/wnba/trial/v7/en/games/{game_id}/boxscore.json',
  'wnba:injuries':     '/wnba/trial/v7/en/league/injuries.json',
  'wnba:teams':        '/wnba/trial/v7/en/league/hierarchy.json',
  'wnba:pbp':          '/wnba/trial/v7/en/games/{game_id}/pbp.json',
  'wnba:summary':      '/wnba/trial/v7/en/games/{game_id}/summary.json',
  'wnba:transfers':    '/wnba/trial/v7/en/league/{year}/{month}/{day}/transfers.json',
  'wnba:free_agents':  '/wnba/trial/v7/en/league/free_agents.json',
  'wnba:changes':      '/wnba/trial/v7/en/league/{year}/{month}/{day}/changes.json',

  // ── Tennis (competition-based; no team/roster concept) ───────────────────
  'tennis:schedule':         '/tennis/trial/v3/en/schedules/{date}/summaries.json',
  'tennis:scores':           '/tennis/trial/v3/en/schedules/{date}/summaries.json',
  'tennis:rankings':         '/tennis/trial/v3/en/rankings.json',
  'tennis:standings':        '/tennis/trial/v3/en/rankings.json',
  'tennis:doubles_rankings': '/tennis/trial/v3/en/double_competitors_rankings.json',
  'tennis:competitions':     '/tennis/trial/v3/en/competitions.json',
  'tennis:live':             '/tennis/trial/v3/en/schedules/live/summaries.json',

  // ── MMA (v2 — v7 is NOT entitled on this key) ────────────────────────────
  'mma:schedule':     '/mma/trial/v2/en/schedules/{date}/summaries.json',
  'mma:scores':       '/mma/trial/v2/en/schedules/{date}/summaries.json',
  'mma:competitions': '/mma/trial/v2/en/competitions.json',
  'mma:events':       '/mma/trial/v2/en/competitions.json',
  'mma:live':         '/mma/trial/v2/en/schedules/live/summaries.json',

  // ── NOT ENTITLED on the current key (all requests 403) ───────────────────
  'nascar:schedule':  '/nascar/trial/v7/en/seasons/{season}/REG/schedule.json',
  'nascar:standings': '/nascar/trial/v7/en/seasons/{season}/standings.json',
  'nascar:entries':   '/nascar/trial/v7/en/races/{race_id}/entry_list.json',
  'nascar:live':      '/nascar/trial/v7/en/races/{race_id}/leaderboard.json',

  'nba_gleague:schedule':  '/gleague/trial/v8/en/games/{season}/REG/schedule.json',
  'nba_gleague:standings': '/gleague/trial/v8/en/seasons/{season}/REG/standings.json',
  'nba_gleague:roster':    '/gleague/trial/v8/en/teams/{team_id}/profile.json',
  'nba_gleague:scores':    '/gleague/trial/v8/en/games/{year}/{month}/{day}/schedule.json',
  'nba_gleague:live':      '/gleague/trial/v8/en/games/{game_id}/boxscore.json',
}

export const sportradar: Provider = {
  id:          'sportradar',
  label:       'Sportradar',
  homepage:    'https://sportradar.com',
  attribution: 'Data licensed from Sportradar',
  base:        'https://api.sportradar.com',
  endpoints:   ENDPOINTS,
  endpointKey: (sport, dataType) => `${sport}:${dataType}`,
  metered:     true,
  license:     'licensed',
  status:      'live',
  // Sportradar is the official distributor for these leagues; its published
  // results are the settlement source for the sports it covers.
  authoritative: true,
  auth: () => ({ query: { api_key: process.env.SPORTRADAR_API_KEY ?? '' } }),
}

/**
 * Sports the current Sportradar key can actually reach. Requests to a
 * non-entitled sport fail fast rather than burning a credit on a guaranteed 403.
 */
export const SPORT_ENTITLED: Record<string, boolean> = {
  nba: true, nhl: true, nfl: true, mlb: true, wnba: true, tennis: true, mma: true,
  nascar: false, nba_gleague: false,
}

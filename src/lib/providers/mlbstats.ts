// src/lib/providers/mlbstats.ts
// MLB Stats API — the same feed that powers MLB.com Gameday. Free, no key,
// genuinely deep.
//
// ─── READ BEFORE ENABLING ────────────────────────────────────────────────────
// license: 'unclear' is doing real work here, not hedging. MLB publishes a
// copyright notice restricting commercial use, and the widely-used Python
// wrapper states plainly that it is not for commercial use. Serving this inside
// a paid staking tier is a genuine legal exposure, not fine print.
//
// The licence gate in lib/serve.ts enforces this mechanically: an 'unclear'
// source returns 451 to any tier above scout, so it cannot leak into a paid
// product by someone forgetting this comment. Do NOT change that flag to 'open'
// without a written position from counsel — the flag IS the control.
//
// Reasonable use: internal reference and cache warming. Unreasonable use:
// reselling it as a settlement feed.

import type { Provider } from './types'

export const mlbstats: Provider = {
  id:          'mlbstats',
  label:       'MLB Stats API',
  homepage:    'https://statsapi.mlb.com',
  attribution: 'Data from MLB Stats API — commercial reuse restricted by MLB',
  base:        'https://statsapi.mlb.com/api/v1',

  endpoints: {
    schedule:  '/schedule?sportId=1&season={season}',
    scores:    '/schedule?sportId=1&date={date}',
    standings: '/standings?leagueId=103,104&season={season}',
    teams:     '/teams?sportId=1&season={season}',
    roster:    '/teams/{team_id}/roster',
    live:      '/game/{game_id}/feed/live',
  },

  metered:       false,
  license:       'unclear',
  status:        'offline',
  offlineReason: 'Free and technically excellent, but MLB restricts commercial reuse. '
               + 'Blocked above the free tier by the licence gate; needs a legal '
               + 'position before it is switched on.',
  authoritative: true,
  politeRpm:     30,
}

// src/lib/providers/nhlweb.ts
// NHL Web API — free, no key, and remarkably deep (play-by-play back to 1918).
//
// ─── READ BEFORE ENABLING ────────────────────────────────────────────────────
// This is an undocumented internal endpoint that happens to be publicly
// reachable. The NHL has not published terms permitting commercial
// redistribution, and an undocumented endpoint carries a second risk a licensed
// feed does not: it can change shape or disappear without notice or recourse.
//
// license: 'unclear' means the gate in lib/serve.ts returns 451 above the free
// tier. Same rule as MLB Stats — the flag is the control, so don't relax it
// without a legal position.
//
// Reasonable use: internal caching and cross-checking our licensed NHL feed.
// Unreasonable use: making it the settlement source for a paid market.

import type { Provider } from './types'

export const nhlweb: Provider = {
  id:          'nhlweb',
  label:       'NHL Web API',
  homepage:    'https://api-web.nhle.com',
  attribution: 'Data from the NHL public web API — redistribution terms unpublished',
  base:        'https://api-web.nhle.com/v1',

  endpoints: {
    schedule:  '/club-schedule-season/{team_id}/{season}',
    scores:    '/score/{date}',
    standings: '/standings/{date}',
    roster:    '/roster/{team_id}/{season}',
    live:      '/gamecenter/{game_id}/boxscore',
    pbp:       '/gamecenter/{game_id}/play-by-play',
  },

  metered:       false,
  license:       'unclear',
  status:        'offline',
  offlineReason: 'Undocumented internal endpoint with no published redistribution '
               + 'terms, and no stability guarantee. Blocked above the free tier by '
               + 'the licence gate.',
  authoritative: true,
  politeRpm:     30,
}

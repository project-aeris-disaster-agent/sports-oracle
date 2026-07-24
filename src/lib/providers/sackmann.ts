// src/lib/providers/sackmann.ts
// Jeff Sackmann's tennis datasets — CC-licensed CSV on GitHub, ATP/WTA results
// and rankings going back decades.
//
// REGISTERED BUT OFFLINE, and unlike the others this one is offline for a
// structural reason rather than a scheduling one: it is not an API. These are
// flat files in a git repository, updated periodically. It cannot settle a live
// market, because the file for today's match does not exist while the match is
// being played.
//
// Its real value is historical depth for backtesting and for filling gaps where
// Sportradar's tennis history is thin. Wiring it up properly means a batch
// importer into our own tables, not a request-time fetch — which is why it is
// registered here for provenance but deliberately not routed to.
//
// TRAP for whoever wires this up: every endpoint below returns text/csv, not
// JSON. fetchUpstream parses JSON and will throw on these until it learns to
// branch on content type.

import type { Provider } from './types'

export const sackmann: Provider = {
  id:          'sackmann',
  label:       'Sackmann Tennis',
  homepage:    'https://github.com/JeffSackmann',
  attribution: 'Historical tennis data by Jeff Sackmann (CC-licensed)',
  base:        'https://raw.githubusercontent.com/JeffSackmann',

  endpoints: {
    atp_matches:  '/tennis_atp/master/atp_matches_{season}.csv',
    wta_matches:  '/tennis_wta/master/wta_matches_{season}.csv',
    atp_rankings: '/tennis_atp/master/atp_rankings_current.csv',
    wta_rankings: '/tennis_wta/master/wta_rankings_current.csv',
    atp_players:  '/tennis_atp/master/atp_players.csv',
  },

  metered:       false,
  license:       'open',
  status:        'offline',
  offlineReason: 'Periodically-updated CSV datasets, not a live API — cannot resolve '
               + 'an in-progress match. Suited to batch historical import, not '
               + 'request-time fetching.',
  // Historical record rather than a governing body's live classification.
  authoritative: false,
  politeRpm:     30,
}

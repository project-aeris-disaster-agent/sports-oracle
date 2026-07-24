// src/lib/providers/openligadb.ts
// OpenLigaDB — fully open, no key, community-run. German football first by
// design: Bundesliga, 2. Bundesliga, DFB-Pokal.
//
// REGISTERED BUT OFFLINE. The endpoint map below is written from OpenLigaDB's
// documented shape and has NOT been probed against the live API, unlike every
// live provider in this directory. Switching it on means verifying these paths
// first and writing a resolution mapper — the response shape is its own thing,
// not Ergast and not Sportradar.
//
// Scope note: this is Bundesliga/DFB-Pokal depth, not EPL or La Liga. If the
// market mix is England/Spain-weighted this contributes very little, which is
// the honest reason it is registered rather than prioritised.

import type { Provider } from './types'

export const openligadb: Provider = {
  id:          'openligadb',
  label:       'OpenLigaDB',
  homepage:    'https://www.openligadb.de',
  attribution: 'German football data via OpenLigaDB (community-run, open)',
  base:        'https://api.openligadb.de',

  endpoints: {
    // getmatchdata returns fixtures AND results in one document, with a
    // matchIsFinished flag per match — close to the whole resolution contract
    // in a single call, which is what makes this worth registering.
    schedule:  '/getmatchdata/{league}/{season}',
    scores:    '/getmatchdata/{league}/{season}',
    matchday:  '/getmatchdata/{league}/{season}/{matchday}',
    standings: '/getbltable/{league}/{season}',
    teams:     '/getavailableteams/{league}/{season}',
    leagues:   '/getavailableleagues',
  },

  metered:       false,
  license:       'open',
  status:        'offline',
  offlineReason: 'Registered, not yet wired. Endpoint paths are unverified and no '
               + 'resolution mapper exists for the OpenLigaDB response shape.',
  authoritative: true,
  politeRpm:     30,
}

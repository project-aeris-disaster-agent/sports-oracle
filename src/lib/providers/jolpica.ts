// src/lib/providers/jolpica.ts
// Jolpica-F1 — the community-run successor to Ergast, same schema, full history
// back to 1950. This is the AUTHORITATIVE F1 source: its classification reflects
// post-race scrutineering and stewards' decisions, which is what a prediction
// market settles on. OpenF1 is faster but provisional (see openf1.ts).
//
// Endpoint scope is deliberately narrow — resolution only. Laps, pit stops,
// circuits and driver reference data are pricing/enrichment concerns and are not
// carried here.
//
// TWO THINGS TO VERIFY AGAINST THE LIVE API BEFORE RELYING ON THIS:
//   1. Jolpica is migrating off the inherited `/ergast/f1` path prefix to a
//      native one. If these 404, the prefix moved — change `base` only.
//   2. Jolpica publishes rate limits materially tighter than Sportradar's 25 QPS
//      (it is volunteer-funded infrastructure). Resolution traffic is low-volume
//      by nature, but the warm cron must not treat this like a paid endpoint.

import type { Provider } from './types'

export const jolpica: Provider = {
  id:          'jolpica',
  label:       'Jolpica-F1',
  homepage:    'https://github.com/jolpica/jolpica-f1',
  attribution: 'F1 results via Jolpica-F1 (community-run Ergast successor)',
  base:        'https://api.jolpi.ca/ergast/f1',

  endpoints: {
    // Event registry — the season calendar, with round numbers and dates.
    // Explicit limit: the Ergast default is 30, and a 24-race calendar is close
    // enough to that ceiling that a future expansion would silently truncate.
    schedule:     '/{season}.json?limit=100',
    // Final classification. The settlement source of truth for F1.
    results:      '/{season}/{round}/results.json?limit=100',
    // Distinct event with its own points scale — never fold into `results`.
    sprint:       '/{season}/{round}/sprint.json',
    qualifying:   '/{season}/{round}/qualifying.json',
    // Championship markets.
    standings:    '/{season}/driverStandings.json',
    constructors: '/{season}/constructorStandings.json',
  },

  metered:       false,
  license:       'open',
  status:        'live',
  authoritative: true,
  // Jolpica publishes limits far tighter than a commercial feed. Resolution
  // traffic is low-volume by nature, so this costs us nothing real.
  politeRpm:     30,
}

// src/lib/providers/riot.ts
// Riot Games API — League of Legends, Valorant, Teamfight Tactics.
//
// REGISTERED BUT OFFLINE, AND EXPECTED TO STAY THAT WAY. Unlike openligadb and
// liquipedia, this is not blocked on engineering effort. It is blocked on policy,
// and no amount of work on our side changes it.
//
// ─── Why ─────────────────────────────────────────────────────────────────────
// Riot's developer terms require an approved production key for any public
// product. Approval is granted for applications that add value for players;
// operating a redistribution service that resells Riot match data to third
// parties is not an approved use case, and running a public product on a
// development key is expressly disallowed. Separately, the pro-play data a
// prediction market actually wants (LCK/LEC/VCT match results) is not served by
// the public developer API at all — it sits behind the esports platform, which
// has no public licence.
//
// So the honest position is that LoL, Valorant and TFT match-level resolution is
// unavailable from any source we may lawfully redistribute. That is a
// publisher-imposed gap, and the artifact was right that the correct response is
// to document it rather than architect around it.
//
// ─── Why register it at all ──────────────────────────────────────────────────
// "Why is there no League of Legends?" is the first question any esports
// integrator asks. Registering the provider means /api/v1/lol answers it in-band,
// with the reason, instead of returning a bare 404 that looks like an oversight.
// This is the case providers/types.ts makes for offline being a first-class state.
//
// The endpoint map is illustrative — these paths are real, but nothing routes
// here and no key is read. If Riot's position ever changes, this file needs a
// status flip and a resolution mapper, not a rewrite.

import type { Provider } from './types'

export const riot: Provider = {
  id:          'riot',
  label:       'Riot Games API',
  homepage:    'https://developer.riotgames.com',
  attribution: 'League of Legends, Valorant and TFT data via Riot Games',
  base:        'https://americas.api.riotgames.com',

  endpoints: {
    // Documented shapes, listed so the gap is legible. Never called.
    results:  '/lol/match/v5/matches/{match_id}',
    schedule: '/lol/match/v5/matches/by-puuid/{puuid}/ids',
  },

  metered:       true,
  // Not 'unclear' — the terms are perfectly clear, they just do not permit this.
  // 'licensed' would imply we hold an agreement. Neither is true, and the
  // distinction matters because serveCached gates on this field.
  license:       'unclear',
  status:        'offline',
  offlineReason: 'Publisher-locked. Riot production keys are not issued for '
               + 'redistribution services, public products may not run on development '
               + 'keys, and professional match results are not exposed by the public '
               + 'developer API. No open alternative exists for these titles.',
  authoritative: false,
}

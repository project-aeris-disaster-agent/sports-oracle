// src/lib/providers/agentfighter.ts
// Agent Fighter — a deterministic browser fighting game where humans and AI
// agents compete in the same arena. Its Results API publishes settled matches,
// play profiles and standings, free and unauthenticated.
//
// ─── Why this counts as authoritative ────────────────────────────────────────
// Two independent reasons, and the second is stronger than anything else in this
// directory:
//
//   1. Agent Fighter operates the game. There is no governing body above it —
//      the publisher's record IS the record, the same standing Valve holds for
//      Dota 2 and the FIA for F1.
//
//   2. The winner is DERIVED, not reported. The server re-simulates the match's
//      complete input ledger from tick 0 on a fixed-point deterministic engine.
//      Neither player asserts the outcome; it is computed. The final state hash
//      is published on every match as `verification.state_hash`, so a
//      counterparty can replay the same inputs on the same engine build and
//      confirm the result independently.
//
// That second property is the same class of guarantee TxLINE's Merkle proofs
// give for soccer: a settlement that can be checked rather than trusted.
//
// ─── Why there is no confirmation window ─────────────────────────────────────
// Dota 2 results are held at `provisional` for six hours because OpenDota can
// re-parse a replay and change the answer, and nothing in its payload
// distinguishes "parsed once" from "settled". Agent Fighter has no such
// ambiguity: `resolution.settlement` is an explicit three-state field where
// `final` is documented as "can never change" and `provisional` means "not yet
// re-simulated, never settle on this". The upstream already models the exact
// state our ageing rule was approximating, so layering a timer on top would
// delay every settlement to re-derive information we are handed directly.
// lib/resolution.ts branches on `settlement` and nothing else.
//
// ─── Terms ───────────────────────────────────────────────────────────────────
// The service descriptor at GET /api/v1 states:
//   "cost": "free", "auth": "none", "cors": "*",
//   "terms": "Open access. Attribution appreciated, not required."
// That is a published permission to reuse, so `license: 'open'` rather than
// 'unclear' — which is what lets this serve paid tiers at all (see the licence
// gate in lib/serve.ts). Attribution ships on every response regardless.
//
// Rate limits: "No hard limit. Responses are CDN-cached; please honour
// Cache-Control rather than polling faster than it." politeRpm below is courtesy
// against a small service, not a documented ceiling.

import type { Provider } from './types'

/** No published limit. A modest self-imposed ceiling on a small free service. */
const POLITE_RPM = 60

/**
 * Rows the event registry is built from.
 *
 * `rated=true` is the upstream's own name for "decided human-vs-human wagers" —
 * the market-relevant population. It is a deliberate filter and worth stating
 * plainly, because a silently filtered registry is a nasty surprise: at the time
 * of writing the platform has run 846 matches of which 794 are arcade practice,
 * so an unfiltered window of 100 would be almost entirely material no market
 * would price, and would push the rated wagers out of view within a day.
 *
 * This narrows DISCOVERY only. /resolve resolves any match id, rated or not, via
 * the per-match endpoint — see the fallback in lib/resolve-dispatch.ts.
 */
const REGISTRY = '/matches?limit=100&rated=true'

export const agentfighter: Provider = {
  id:          'agentfighter',
  label:       'Agent Fighter',
  homepage:    'https://play.agentfighter.wtf',
  attribution: 'Match results via the Agent Fighter Results API (open access) — '
             + 'winners derived by deterministic re-simulation of the match input ledger',
  base:        'https://agent-fighter-web.vercel.app/api/v1',

  endpoints: {
    // Settled matches, newest first. Doubles as the event registry and the
    // primary resolution feed: one cached document answers most lookups.
    schedule:  REGISTRY,
    // Single match, complete. Documented as immutable once written.
    results:   '/matches/{match_id}',
    // Ranked ladder for the current season. Rated players only by default,
    // which is the real ladder — see the note on the sport entry about it being
    // legitimately empty early in a 21-day season.
    standings: '/leaderboard?board=season&limit=100',
    // The roster with records and lifetime + season Elo. Richer than the board:
    // this is the base-rate table a player-prop model reads.
    leaders:   '/players?sort=elo&limit=100',
  },

  metered:       false,
  license:       'open',
  status:        'live',
  authoritative: true,
  politeRpm:     POLITE_RPM,

  // No credentials of any kind. Stated rather than omitted so nobody later
  // assumes a key was forgotten.

  /**
   * Collapses the two match-bearing endpoints onto one shape.
   *
   * /matches returns `{ matches: [...], pagination, meta }` and /matches/{id}
   * returns `{ match: {...}, meta }`. Normalising both to `{ matches: [...] }`
   * means the mapper in lib/resolution.ts reads one form and never has to know
   * which endpoint a row arrived from — the same reason providers/opendota.ts
   * flattens OpenDota's three field spellings.
   *
   * `meta` is dropped because it carries `generated_at`, a fresh timestamp on
   * every fetch. Keeping it would make two byte-identical documents compare
   * unequal for no reason.
   *
   * The match objects themselves are NOT trimmed. Unlike OpenDota's per-match
   * telemetry, these are a few hundred bytes and every field is load-bearing:
   * `verification.state_hash` and `verification.engine` are the provenance a
   * settlement dispute is answered from, so discarding them to save bytes would
   * throw away the reason this source is trustworthy.
   *
   * Standings and leaders pass through untouched — they are pass-through
   * surfaces with no normalised contract to satisfy.
   */
  project(data, dataType) {
    if (dataType === 'results') {
      const one = (data as { match?: unknown })?.match
      return { matches: one ? [one] : [] }
    }
    if (dataType === 'schedule') {
      const d = data as { matches?: unknown; pagination?: unknown }
      return {
        matches:    Array.isArray(d?.matches) ? d.matches : [],
        pagination: d?.pagination ?? null,
      }
    }
    return data
  },
}

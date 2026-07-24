// src/lib/providers/txline.ts
// TxLINE (TxODDS) — soccer fixtures, odds and scores, with every data point
// anchored to Solana via Merkle proofs. Verified against the live API 2026-07-25.
//
// ─── Why this one matters for prediction markets ─────────────────────────────
// Every other provider asks you to trust that the number you were handed is the
// number that was published. TxLINE exposes validation endpoints returning a
// Merkle proof for a specific update, so a settlement can be independently
// verified against an on-chain root. For a market that pays out real money on
// our say-so, that is a materially different guarantee.
//
// ─── Auth: two credentials, one of which expires ─────────────────────────────
//   X-Api-Token   long-lived, issued by on-chain activation. The durable secret.
//   Authorization  Bearer <guest JWT>, valid 30 days, minted by an UNAUTHENTICATED
//                  POST /auth/guest/start.
//
// The JWT in .env expires. Pinning it would have quietly broken this integration
// mid-season, so we mint our own and refresh ahead of expiry. A freshly minted
// guest JWT was confirmed to work with the existing API token, which is what
// makes self-healing auth possible here.
//
// NOTE ON THE SOLANA KEY: TXLINE_SOLANA_PRIVATE_KEY is NOT read by this module
// and must never be. It signs the one-time on-chain activation that issues the
// API token — an operator action, not a request-path one. A wallet private key
// in the web app's runtime environment is a standing risk with no upside; the
// only thing the request path needs is the resulting API token.

import type { Provider, ProviderAuth } from './types'

const HOST = process.env.TXLINE_BASE_URL ?? 'https://txline.txodds.com'

// ─── Guest JWT cache ─────────────────────────────────────────────────────────
// Module-scoped, so one mint serves every request on the instance. Refreshed an
// hour before expiry rather than on failure, so a request never pays the latency
// of discovering the token died.
const SKEW_MS = 60 * 60 * 1000

let cached: { token: string; expiresAt: number } | null = null
let inFlight: Promise<string> | null = null

function expiryOf(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function mintGuestJwt(): Promise<string> {
  const res = await fetch(`${HOST}/auth/guest/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    '{}',
  })
  if (!res.ok) throw new Error(`guest session request returned ${res.status}`)

  const body = await res.json() as { token?: string }
  if (!body.token) throw new Error('guest session response contained no token')
  return body.token
}

/** Returns a valid guest JWT, minting one when the cached token is near expiry. */
export async function guestJwt(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - SKEW_MS) return cached.token

  // Collapse concurrent refreshes onto one request — a cold instance under load
  // would otherwise open a session per request.
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const token = await mintGuestJwt()
      cached = { token, expiresAt: expiryOf(token) }
      return token
    } catch (err) {
      // Fall back to the seed token from the environment if it is still valid.
      // This only helps until that token expires, which is exactly why we mint.
      const seed = process.env.TXLINE_GUEST_JWT
      if (seed && Date.now() < expiryOf(seed) - SKEW_MS) {
        console.warn('[txline] could not mint a guest JWT, using TXLINE_GUEST_JWT:', (err as Error).message)
        cached = { token: seed, expiresAt: expiryOf(seed) }
        return seed
      }
      throw err
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

async function txlineAuth(): Promise<ProviderAuth> {
  const apiToken = process.env.TXLINE_API_TOKEN
  if (!apiToken) throw new Error('TXLINE_API_TOKEN is not set')

  return {
    headers: {
      Authorization:  `Bearer ${await guestJwt()}`,
      'X-Api-Token':  apiToken,
    },
  }
}

export const txline: Provider = {
  id:          'txline',
  label:       'TxLINE (TxODDS)',
  homepage:    'https://txodds.net/our-products/tx-line/',
  attribution: 'Soccer data via TxLINE by TxODDS — Solana-anchored, Merkle-verifiable',
  base:        `${HOST}/api`,

  endpoints: {
    // Fixtures. `startEpochDay` is days since the Unix epoch and the window is
    // capped at 30 days forward by the API, not by us.
    schedule:      '/fixtures/snapshot?startEpochDay={epoch_day}',
    competition:   '/fixtures/snapshot?startEpochDay={epoch_day}&competitionId={competition_id}',

    // Scores. `snapshot` returns the latest event PER ACTION TYPE, not a
    // time-ordered log — see the ordering trap in lib/resolution.ts.
    scores:        '/scores/snapshot/{fixture_id}',
    score_updates: '/scores/updates/{fixture_id}',

    // Odds.
    odds:          '/odds/snapshot/{fixture_id}',
    odds_updates:  '/odds/updates/{fixture_id}',

    // Merkle proofs — the verifiable-settlement path.
    // Requires BOTH fixtureId and seq: the proof is scoped to one specific score
    // update, not the fixture as a whole. The seq worth proving is the one the
    // settlement was read from — /resolve reports it as `settled_seq`.
    validation:    '/scores/stat-validation?fixtureId={fixture_id}&seq={seq}&statKeys={stat_keys}',
  },

  metered:       false,
  license:       'licensed',
  status:        'live',
  // TxLINE publishes the settlement figure and anchors it on-chain. For soccer
  // it is the authority we settle against.
  authoritative: true,
  politeRpm:     60,
  auth:          txlineAuth,
}

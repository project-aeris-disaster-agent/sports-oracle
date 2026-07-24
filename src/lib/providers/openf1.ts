// src/lib/providers/openf1.ts
// OpenF1 — free, keyless, built explicitly as an open community resource.
//
// Scope here is RESOLUTION ONLY, which cuts most of what OpenF1 is famous for.
// Telemetry at 3.7Hz, team radio, weather, laps, stints and intervals are all
// pricing signals, not settlement inputs, and are deliberately absent. Add them
// behind a separate pricing surface if that product ever exists — do not smuggle
// them in here.
//
// NOT AUTHORITATIVE. OpenF1 knows the finishing order seconds after the flag; it
// does not know about the penalty applied ninety minutes later. It fills the fast
// provisional path and is capped at `provisional` by the resolution layer no
// matter how complete its answer looks.
//
// All paths below were probed against the live API on 2026-07-25.
//
// TRAP: OpenF1 does NOT accept a `limit` query parameter — passing one returns
// 404, not a truncated list. Never add pagination params to these templates.

import type { Provider } from './types'

export const openf1: Provider = {
  id:          'openf1',
  label:       'OpenF1',
  homepage:    'https://openf1.org',
  attribution: 'Live F1 timing via OpenF1 (open community resource)',
  base:        'https://api.openf1.org/v1',

  endpoints: {
    // Session identity + scheduled start. Event registry for the live path.
    sessions:       '/sessions?year={season}',
    session:        '/sessions?session_key={session_key}',
    // Provisional classification. Carries dnf/dns/dsq flags, lap count and
    // points directly, so it maps onto the resolution contract without inference.
    session_result: '/session_result?session_key={session_key}',
    // Append-only running-order stream. In-play ordering only — session_result
    // is the better source once a session has ended.
    position:       '/position?session_key={session_key}',
    // Penalties, DSQs, red flags. The signal to WITHHOLD settlement — this is
    // why race_control survived the resolution-only cut and telemetry did not.
    race_control:   '/race_control?session_key={session_key}',
    drivers:        '/drivers?session_key={session_key}',
  },

  metered:       false,
  license:       'open',
  status:        'live',
  authoritative: false,
  politeRpm:     60,
}

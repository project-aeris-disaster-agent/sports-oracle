// src/lib/params.ts
// Cheap shape checks for request-supplied identifiers.
//
// These exist to stop a malformed id reaching a metered upstream. Without them a
// caller passing `game_id=garbage` produces a real Sportradar request that costs
// a credit and comes back 404 — so a loop of bad ids drains quota, and MMA's
// allocation is only 2,500/month. Rejecting locally costs nothing.
//
// The second reason is honesty about status codes: TxLINE answers a non-numeric
// `seq` with a 500, which we would otherwise pass through as "our server broke"
// when it is in fact a client input error.
//
// Deliberately loose. This is a shape guard, not validation — the upstream
// remains the authority on whether an id exists. Anything that could plausibly
// be a real id must pass, or we would reject valid requests to save a credit.

/** Sportradar ids are UUIDs; a few legacy feeds use shorter alphanumeric keys. */
const UUID_ISH = /^[0-9a-z]{6,}(-[0-9a-z]+)*$/i
const NUMERIC  = /^\d+$/

const SHAPES: Record<string, { test: (v: string) => boolean; expected: string }> = {
  game_id:    { test: v => UUID_ISH.test(v), expected: 'an alphanumeric/UUID game id' },
  team_id:    { test: v => UUID_ISH.test(v), expected: 'an alphanumeric/UUID team id' },
  race_id:    { test: v => UUID_ISH.test(v), expected: 'an alphanumeric/UUID race id' },
  fixture_id: { test: v => NUMERIC.test(v),  expected: 'a numeric fixture id' },
  seq:        { test: v => NUMERIC.test(v),  expected: 'a numeric sequence number' },
  round:      { test: v => NUMERIC.test(v),  expected: 'a numeric round' },
  week:       { test: v => NUMERIC.test(v) && +v >= 1 && +v <= 30, expected: 'a week between 1 and 30' },
  season:     { test: v => /^\d{4}$/.test(v), expected: 'a 4-digit season year' },
  date:       { test: v => /^\d{4}-\d{2}-\d{2}$/.test(v), expected: 'a date as YYYY-MM-DD' },
  epoch_day:  { test: v => NUMERIC.test(v),  expected: 'a numeric epoch day' },
}

export interface ParamProblem { param: string; value: string; expected: string }

/** Returns the first malformed parameter, or null when everything looks plausible. */
export function checkParams(args: Record<string, string | undefined>): ParamProblem | null {
  for (const [param, value] of Object.entries(args)) {
    if (value === undefined || value === '') continue
    const shape = SHAPES[param]
    if (shape && !shape.test(value)) {
      return { param, value, expected: shape.expected }
    }
  }
  return null
}

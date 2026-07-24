// src/lib/providers/opendota.ts
// OpenDota — Dota 2 professional match data. MIT-licensed platform, and the only
// esports source in this directory with match-level coverage we may redistribute.
//
// ─── Why this counts as authoritative ────────────────────────────────────────
// `radiant_win` does not originate with OpenDota. It is read from Valve's own
// WebAPI — the publisher's record of the match, which for Dota 2 is the governing
// body. That is the same standard Jolpica meets for F1 and is why this provider
// may mark a result official at all. Everything else OpenDota computes (ratings,
// benchmarks, scenarios) is derived analysis and carries no such standing.
//
// ─── Scope: three endpoints ──────────────────────────────────────────────────
// /heroes, /players, /benchmarks, /scenarios and /explorer are analytics, not
// resolution. They answer "how did they win", which no market settles on, and
// they would dominate the cache. Deliberately absent.
//
// ─── The re-parse risk, and where it is handled ──────────────────────────────
// A match can appear in /proMatches before replay parsing completes, and rare
// technical remakes exist. That is why a fresh result is NOT immediately official:
// lib/resolution.ts holds it at `provisional` until it has stood unchanged for a
// confirmation window. That rule lives with the mapper because it is a statement
// about confidence in the data, not about how it is fetched.

import type { Provider } from './types'

/** Free tier is 60 req/min; leave headroom so a warm run can't trip the ceiling. */
const POLITE_RPM = 50

interface RawMatch {
  match_id?:     number | string
  radiant_win?:  boolean
  radiant_score?: number
  dire_score?:   number
  start_time?:   number
  duration?:     number
  leagueid?:     number
  league_id?:    number
  league_name?:  string
  league?:       { name?: string }
  radiant_name?: string
  dire_name?:    string
  radiant_team?: { name?: string }
  dire_team?:    { name?: string }
  team_name_radiant?: string
  team_name_dire?:    string
  series_id?:    number
  series_type?:  number
}

/**
 * The resolution slice of a match document.
 *
 * Three OpenDota endpoints describe the same match with three different field
 * names for the same thing — /proMatches says `radiant_name`, /matches/{id} says
 * `radiant_team.name`, /live says `team_name_radiant`. Collapsing them here means
 * the mapper in lib/resolution.ts reads one shape and does not have to know which
 * endpoint the row arrived from.
 *
 * This runs as the provider's `project`, so the trimmed form is what reaches the
 * cache. /matches/{id} is the reason it must: the raw document carries full
 * per-player telemetry — hundreds of KB to answer a single boolean.
 */
function slim(m: RawMatch): Record<string, unknown> {
  return {
    match_id:      m.match_id != null ? String(m.match_id) : null,
    // Left undefined when absent rather than coerced to false. `undefined` means
    // "not yet resolved"; false means "dire won". Collapsing them would settle
    // every in-progress match in favour of dire.
    radiant_win:   typeof m.radiant_win === 'boolean' ? m.radiant_win : undefined,
    radiant_score: m.radiant_score ?? null,
    dire_score:    m.dire_score ?? null,
    start_time:    m.start_time ?? null,
    duration:      m.duration ?? null,
    league_id:     m.leagueid != null ? String(m.leagueid)
                 : m.league_id != null ? String(m.league_id) : null,
    league_name:   m.league_name ?? m.league?.name ?? null,
    radiant_name:  m.radiant_name ?? m.radiant_team?.name ?? m.team_name_radiant ?? null,
    dire_name:     m.dire_name ?? m.dire_team?.name ?? m.team_name_dire ?? null,
    series_id:     m.series_id != null ? String(m.series_id) : null,
    series_type:   m.series_type ?? null,
  }
}

export const opendota: Provider = {
  id:          'opendota',
  label:       'OpenDota',
  homepage:    'https://www.opendota.com',
  attribution: 'Dota 2 match data via OpenDota (MIT) — sourced from the Valve WebAPI',
  base:        'https://api.opendota.com/api',

  endpoints: {
    // Completed professional matches, most recent first. Doubles as the event
    // registry and the primary resolution feed: one cached document answers most
    // lookups, because a market almost always settles within its window.
    schedule: '/proMatches',
    // Single-match confirmation, for matches that have aged out of /proMatches.
    results:  '/matches/{match_id}',
    // In-progress professional matches. No winner exists by definition.
    live:     '/live',
  },

  metered:       false,
  license:       'open',
  status:        'live',
  authoritative: true,
  politeRpm:     POLITE_RPM,

  // Optional. Without a key the public limits still allow this comfortably;
  // with one they are raised. Absent key must not send `api_key=` at all.
  auth: () => {
    const key = process.env.OPENDOTA_API_KEY
    return key ? { query: { api_key: key } } : {}
  },

  project(data, dataType) {
    // /proMatches and /live return bare arrays; /matches/{id} a single object.
    if (Array.isArray(data)) {
      const rows = (data as RawMatch[]).map(slim)
      // /live carries no radiant_win and never will, so the absence must not be
      // read as "awaiting parse" — tag the rows for what they are.
      if (dataType === 'live') for (const r of rows) r.in_progress = true
      return rows
    }
    return slim((data ?? {}) as RawMatch)
  },
}

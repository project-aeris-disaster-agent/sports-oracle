// src/lib/providers/index.ts
// The routing table. This is the entire configuration surface for adding a sport
// or swapping a data source — no route touches a provider directly.
//
// Adding a sport is: one provider file (only if the upstream is new), one entry
// here, one entry in capabilities.ts. No route edits, no migration.

import type { Provider, ProviderId } from './types'
import { sportradar, SPORT_ENTITLED } from './sportradar'
import { jolpica }    from './jolpica'
import { openf1 }     from './openf1'
import { openligadb } from './openligadb'
import { sackmann }   from './sackmann'
import { mlbstats }   from './mlbstats'
import { nhlweb }     from './nhlweb'
import { txline }     from './txline'
import { opendota }   from './opendota'
import { liquipedia } from './liquipedia'
import { riot }       from './riot'
import { agentfighter } from './agentfighter'

export * from './types'
export { SPORT_ENTITLED }

export const PROVIDERS: Record<ProviderId, Provider> = {
  sportradar, jolpica, openf1, openligadb, sackmann, mlbstats, nhlweb, txline,
  opendota, liquipedia, riot, agentfighter,
}

interface Route {
  /** Handles every dataType not named in `overrides`. */
  default: Provider
  /**
   * Per-dataType source selection. This is what lets one sport draw history from
   * one provider and live state from another without any branching in a route —
   * F1 settles on Jolpica and streams from OpenF1, expressed as config.
   */
  overrides?: Record<string, Provider>
  /**
   * Additional upstreams a caller may select explicitly with `?provider=`.
   *
   * This is the router half of the product: the same sport can be answered by
   * more than one source, and which one you want is a judgement — licensed and
   * billable, or open and free-but-unofficial. We publish the choice instead of
   * making it silently. Alternates are opt-in; the default never changes.
   */
  alternates?: Provider[]
}

export const ROUTING: Record<string, Route> = {
  nba:         { default: sportradar },
  nfl:         { default: sportradar },
  wnba:        { default: sportradar },
  nascar:      { default: sportradar },
  nba_gleague: { default: sportradar },

  nhl:    { default: sportradar, alternates: [nhlweb] },
  mlb:    { default: sportradar, alternates: [mlbstats] },
  tennis: { default: sportradar, alternates: [sackmann] },
  mma:    { default: sportradar },

  f1: {
    default:   jolpica,
    overrides: {
      sessions:       openf1,
      session:        openf1,
      session_result: openf1,
      position:       openf1,
      race_control:   openf1,
      drivers:        openf1,
    },
  },

  soccer:   { default: txline, alternates: [openligadb] },
  football: { default: openligadb },

  // ─── Esports ────────────────────────────────────────────────────────────────
  // Two titles serve. Every other one routes to a provider that is registered
  // and OFFLINE, which is deliberate: the router publishes what it could reach
  // and why it does not, so an integrator gets a 503 naming the actual blocker
  // instead of a 404 that reads like an oversight. See capabilities.ts for the
  // per-title tags.
  dota2: { default: opendota, alternates: [liquipedia] },

  // The only title here whose operator publishes its own results API. That makes
  // it the sole source by construction — there is no second party with standing
  // to corroborate a match Agent Fighter itself simulated, so no alternates.
  agentfighter: { default: agentfighter },

  // Publisher-locked. Riot does not license redistribution; no open fallback.
  lol:      { default: riot, alternates: [liquipedia] },
  valorant: { default: riot, alternates: [liquipedia] },
  tft:      { default: riot },

  // A Liquipedia wiki exists for each of these and is the only candidate source,
  // so they inherit its offline status until a placement parser exists.
  cs2:          { default: liquipedia },
  starcraft2:   { default: liquipedia },
  rocketleague: { default: liquipedia },
  overwatch:    { default: liquipedia },
  rainbow6:     { default: liquipedia },
  cod:          { default: liquipedia },
  mlbb:         { default: liquipedia },
  // Battle royale. Placement-and-points scoring rather than head-to-head — the
  // Competitor contract already models it (position = placement, points = points),
  // so the blocker here is the source, not the shape.
  apex:     { default: liquipedia },
  pubg:     { default: liquipedia },
  fortnite: { default: liquipedia },
}

/** Every provider a sport may legitimately be served from, default first. */
export function providersFor(sport: string): Provider[] {
  const route = ROUTING[sport]
  if (!route) return []
  const seen = new Map<ProviderId, Provider>()
  seen.set(route.default.id, route.default)
  for (const p of Object.values(route.overrides ?? {})) seen.set(p.id, p)
  for (const p of route.alternates ?? [])                seen.set(p.id, p)
  return [...seen.values()]
}

/** Backwards-compatible alias — attribution surfaces read this. */
export const sourcesFor = providersFor

export type ProviderResolution =
  | { ok: true;  provider: Provider; isDefault: boolean }
  | { ok: false; reason: 'unknown-sport' | 'unknown-provider' | 'offline'; provider?: Provider; options: Provider[] }

/**
 * Picks the upstream for a request.
 *
 * `preferred` comes from `?provider=` and is validated against this sport's own
 * option list — a caller cannot name an arbitrary provider and have it routed,
 * which would otherwise let them reach a source the sport was never wired to.
 * An offline provider resolves to a refusal rather than being silently ignored:
 * quietly serving the default when someone explicitly asked for something else
 * would hand them data they did not ask for under a licence they did not check.
 */
export function resolve(sport: string, dataType: string, preferred?: string | null): ProviderResolution {
  const route = ROUTING[sport]
  if (!route) return { ok: false, reason: 'unknown-sport', options: [] }

  const options = providersFor(sport)
  const fallback = route.overrides?.[dataType] ?? route.default

  if (!preferred) {
    return fallback.status === 'offline'
      ? { ok: false, reason: 'offline', provider: fallback, options }
      : { ok: true, provider: fallback, isDefault: true }
  }

  const chosen = options.find(p => p.id === preferred)
  if (!chosen) return { ok: false, reason: 'unknown-provider', options }
  if (chosen.status === 'offline') return { ok: false, reason: 'offline', provider: chosen, options }

  return { ok: true, provider: chosen, isDefault: chosen.id === fallback.id }
}

/**
 * Convenience wrapper for callers that only need the provider and treat every
 * failure the same way (attribution, manifests). Request paths should use
 * `resolve` so they can report *why* a selection was refused.
 */
export function resolveProvider(sport: string, dataType: string, preferred?: string | null): Provider | undefined {
  const r = resolve(sport, dataType, preferred)
  if (r.ok) return r.provider
  return r.reason === 'offline' ? r.provider : ROUTING[sport]?.overrides?.[dataType] ?? ROUTING[sport]?.default
}

/** Public-facing attribution for a sport. Safe to render or serialise anywhere. */
export interface SourceRef {
  id:            ProviderId
  label:         string
  homepage:      string
  attribution:   string
  license:       Provider['license']
  status:        Provider['status']
  offlineReason?: string
  authoritative: boolean
  /** True for the provider used when no `?provider=` is supplied. */
  isDefault:     boolean
}

export function toSourceRef(p: Provider, isDefault = false): SourceRef {
  return {
    id: p.id, label: p.label, homepage: p.homepage, attribution: p.attribution,
    license: p.license, status: p.status, offlineReason: p.offlineReason,
    authoritative: p.authoritative, isDefault,
  }
}

export function sourceRefs(sport: string): SourceRef[] {
  const def = ROUTING[sport]?.default
  return providersFor(sport).map(p => toSourceRef(p, p.id === def?.id))
}

export const SPORT_KEYS = Object.keys(ROUTING)

/**
 * The strictest courtesy limit applying to a sport, or undefined if none of its
 * providers ask for one. Only live providers count — an offline source serves no
 * traffic, so letting it tighten the limit would throttle the sport for nothing.
 */
export function politeRpmFor(sport: string): number | undefined {
  const limits = providersFor(sport)
    .filter(p => p.status === 'live')
    .map(p => p.politeRpm)
    .filter((n): n is number => typeof n === 'number')
  return limits.length ? Math.min(...limits) : undefined
}

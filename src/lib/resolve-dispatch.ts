// src/lib/resolve-dispatch.ts
// Maps a sport onto its event-registry and resolution mappers.
//
// The /events and /resolve routes stay sport-agnostic: they handle auth, cache,
// TTL and the response envelope, and ask this module what to fetch and how to
// normalise it. Adding a resolvable sport is a mapper plus one entry here — no
// route edits, which is the same plug-and-play rule the provider registry follows.

import { getOrFetch }    from '@/lib/serve'
import { currentSeason } from '@/lib/upstream'
import { qualifierFor }  from '@/lib/cache-key'
import { ttlFor }        from '@/lib/capabilities'
import {
  fromJolpica,  eventsFromJolpica,
  fromTxLine,   eventsFromTxLine,
  fromOpenDota, eventsFromOpenDota, findDotaMatch,
  fromAgentFighter, eventsFromAgentFighter, findAgentFighterMatch, agentFighterMatches,
  type Resolution, type EventRef,
} from '@/lib/resolution'

export interface EventQuery { season?: string; from?: string; to?: string }

interface SportResolver {
  /** Fetches and normalises the event registry. */
  events: (sport: string, q: EventQuery) => Promise<{ events: EventRef[]; fromCache: boolean; season: string }>
  /** Fetches and normalises one event's outcome. */
  resolve: (sport: string, eventId: string) => Promise<{ resolution: Resolution | null; fromCache: boolean; cacheKey: string; dataType: string; data?: unknown }>
  /** Human hint shown when an event_id doesn't parse. */
  idFormat: string
}

// ─── F1 (Jolpica) ────────────────────────────────────────────────────────────

const F1_EVENTS_TTL   = 86400
const F1_PENDING_TTL  = 300

const f1: SportResolver = {
  idFormat: '{season}-{round}, e.g. 2026-1',

  async events(sport, q) {
    const season = q.season ?? currentSeason(sport)
    const { data, fromCache } = await getOrFetch({
      sport, dataType: 'schedule', qualifier: season, ttl: F1_EVENTS_TTL, params: { season },
    })
    return { events: eventsFromJolpica(sport, data), fromCache, season }
  },

  async resolve(sport, eventId) {
    const m = /^(\d{4})-(\d{1,2})(-sprint)?$/.exec(eventId.trim())
    if (!m) return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
    const [, season, round, sprint] = m
    const dataType = sprint ? 'sprint' : 'results'

    const { data, cacheKey, fromCache } = await getOrFetch({
      sport, dataType, qualifier: `${season}-${round}`, ttl: F1_PENDING_TTL,
      params: { season, round },
    })
    return { resolution: fromJolpica(sport, data, { sprint: Boolean(sprint) }), fromCache, cacheKey, dataType, data }
  },
}

// ─── Soccer (TxLINE) ─────────────────────────────────────────────────────────

const SOCCER_EVENTS_TTL  = 3600
const SOCCER_PENDING_TTL = 60

/** How far back to look when resolving a fixture id to its participant names. */
const SOCCER_LOOKBACK_DAYS = 90

/** TxLINE addresses its fixture window by days since the Unix epoch. */
export const epochDayOf = (d: Date | string = new Date()): number =>
  Math.floor(new Date(d).getTime() / 86400000)

const soccer: SportResolver = {
  idFormat: 'a numeric TxLINE fixture id, e.g. 18257739',

  async events(sport, q) {
    // `from` doubles as the window anchor: TxLINE returns fixtures starting at
    // or within 30 days after the given epoch day, so paging back is how you
    // reach played fixtures.
    const epochDay = String(epochDayOf(q.from ?? new Date()))
    const { data, fromCache } = await getOrFetch({
      sport, dataType: 'schedule', qualifier: epochDay, ttl: SOCCER_EVENTS_TTL,
      params: { epoch_day: epochDay },
    })
    return { events: eventsFromTxLine(sport, data), fromCache, season: currentSeason(sport) }
  },

  async resolve(sport, eventId) {
    if (!/^\d+$/.test(eventId.trim())) {
      return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
    }
    const fixtureId = eventId.trim()

    const { data, cacheKey, fromCache } = await getOrFetch({
      sport, dataType: 'scores', qualifier: fixtureId, ttl: SOCCER_PENDING_TTL,
      params: { fixture_id: fixtureId },
    })

    // The fixture list carries the names and kickoff time; the score feed does
    // not. Best-effort — a missing registry entry degrades the label, not the
    // result, so it must never fail the resolution.
    //
    // Anchored well back: TxLINE returns fixtures starting at or after the given
    // epoch day, so the current-day window contains only upcoming matches and
    // would never match a fixture that has already been played — which is
    // precisely the case /resolve is for.
    let ref = { fixtureId: Number(fixtureId) }
    try {
      const lookback = new Date(Date.now() - SOCCER_LOOKBACK_DAYS * 86400000).toISOString()
      const reg = await soccer.events(sport, { from: lookback })
      const hit = reg.events.find(e => e.event_id === fixtureId)
      if (hit) {
        const [p1, p2] = hit.name.split(' v ')
        ref = {
          fixtureId: Number(fixtureId),
          participant1: p1, participant2: p2,
          startTime: hit.scheduled_at ? Date.parse(hit.scheduled_at) : undefined,
        } as typeof ref
      }
    } catch { /* label-only enrichment */ }

    const events = Array.isArray(data) ? data : []
    return { resolution: fromTxLine(sport, events as never[], ref), fromCache, cacheKey, dataType: 'scores', data }
  },
}

// ─── Dota 2 (OpenDota) ───────────────────────────────────────────────────────

// Read from the capability manifest, NOT declared here.
//
// /api/internal/warm writes cache entries using the manifest TTL. A local copy
// that disagreed would mean the warm job pinning the rolling feed for the
// manifest's lifetime while this module assumed a shorter one — the feed would
// silently go stale and every settlement would fall through to a per-match fetch.
// The fallbacks only apply if the endpoint is ever removed from the manifest.
const dotaFeedTtl    = () => ttlFor('dota2', 'events',  300)
const dotaPendingTtl = () => ttlFor('dota2', 'resolve', 600)

/**
 * The feed is one cached document covering the ~100 most recent professional
 * matches, so the overwhelmingly common case — a market settling within hours or
 * days of the match — is answered from a single cache entry shared by every
 * caller, at zero marginal upstream cost. Only matches that have aged out of that
 * window fall through to a per-match fetch.
 *
 * Same shape as the soccer resolver, which enriches from its fixture registry.
 */
const dota2: SportResolver = {
  idFormat: 'a numeric OpenDota match id, e.g. 8123456789',

  async events(sport, q) {
    const { data, fromCache } = await getOrFetch({
      sport, dataType: 'schedule',
      // Not season-scoped: /proMatches is a rolling window. qualifierFor() returns
      // the same literal for this sport so the warm job writes the key the
      // resolver reads — a mismatch there silently warms an entry nobody looks at.
      qualifier: qualifierFor(sport, 'events', {}),
      ttl: dotaFeedTtl(), params: {},
    })
    return { events: eventsFromOpenDota(sport, data), fromCache, season: q.season ?? currentSeason(sport) }
  },

  async resolve(sport, eventId) {
    const matchId = eventId.trim()
    if (!/^\d+$/.test(matchId)) {
      return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
    }

    // 1. The feed first. Cheap, and usually a hit.
    try {
      const feed = await getOrFetch({
        sport, dataType: 'schedule', qualifier: qualifierFor(sport, 'events', {}),
        ttl: dotaFeedTtl(), params: {},
      })
      const hit = findDotaMatch(feed.data, matchId)
      if (hit) {
        // cacheKey is deliberately empty: /resolve promotes the key it is handed
        // to a 30-day TTL once official, and this key is the ROLLING FEED. Pinning
        // that for 30 days would freeze the registry at today's 100 matches and
        // break every subsequent lookup. Once the match ages out of the window the
        // per-match path below takes over and promotes its own entry safely.
        return {
          resolution: fromOpenDota(sport, hit),
          fromCache:  feed.fromCache,
          cacheKey:   '',
          dataType:   'schedule',
        }
      }
    } catch {
      // A feed outage must not block a per-match lookup that would succeed.
    }

    // 2. Aged out of the feed — fetch the match itself.
    const { data, cacheKey, fromCache } = await getOrFetch({
      sport, dataType: 'results', qualifier: matchId,
      ttl: dotaPendingTtl(), params: { match_id: matchId },
    })

    return {
      resolution: fromOpenDota(sport, data as never),
      fromCache, cacheKey, dataType: 'results',
    }
  },
}

// ─── Agent Fighter ───────────────────────────────────────────────────────────

// Read from the manifest for the same reason dota2 does — /api/internal/warm
// writes with the manifest TTL, so a local copy that disagreed would leave the
// warm job pinning the rolling feed while this module assumed a shorter life.
const afFeedTtl    = () => ttlFor('agentfighter', 'events',  300)
const afPendingTtl = () => ttlFor('agentfighter', 'resolve', 300)

/**
 * Match ids are opaque strings, e.g. `mms59mpyic0a5-6` — a session id and a
 * match ordinal.
 *
 * Explicitly NOT the `/^\d+$/` guard the F1, soccer and Dota 2 resolvers use.
 * Copying that pattern here would reject every valid id and make /resolve
 * permanently 400. The bound exists so a malformed id fails fast with the
 * format hint rather than becoming an upstream 404.
 */
const AF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const agentfighter: SportResolver = {
  idFormat: 'an Agent Fighter match id, e.g. mms59mpyic0a5-6',

  async events(sport, q) {
    const { data, fromCache } = await getOrFetch({
      sport, dataType: 'schedule',
      // Not season-scoped: this is a rolling window of recently settled matches.
      // qualifierFor returns the same literal so the warm job writes the key the
      // resolver reads.
      qualifier: qualifierFor(sport, 'events', {}),
      ttl: afFeedTtl(), params: {},
    })

    const events = eventsFromAgentFighter(sport, data)
    // Agent Fighter seasons are 21-day cycles numbered from 1, so neither the
    // calendar year nor a manifest constant is the real answer. Take it from the
    // newest row in the feed and fall back only if the feed is empty.
    const season = q.season ?? events[0]?.season ?? currentSeason(sport)
    return { events, fromCache, season }
  },

  async resolve(sport, eventId) {
    const matchId = eventId.trim()
    if (!AF_ID.test(matchId)) {
      return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
    }

    // 1. The registry feed first — one cached document, usually a hit.
    try {
      const feed = await getOrFetch({
        sport, dataType: 'schedule', qualifier: qualifierFor(sport, 'events', {}),
        ttl: afFeedTtl(), params: {},
      })
      const hit = findAgentFighterMatch(feed.data, matchId)
      if (hit) {
        // cacheKey deliberately empty: /resolve promotes the key it is handed to
        // a 30-day TTL once official, and this key is the ROLLING FEED. Pinning
        // it would freeze the registry at today's matches. The per-match path
        // below promotes its own entry safely.
        return {
          resolution: fromAgentFighter(sport, hit),
          fromCache:  feed.fromCache,
          cacheKey:   '',
          dataType:   'schedule',
        }
      }
    } catch {
      // A feed outage must not block a per-match lookup that would succeed.
    }

    // 2. Not in the registry — fetch the match directly.
    //
    // This is also the path for every unrated match: the feed is filtered to
    // rated wagers (see providers/agentfighter.ts), so arcade, solo and friendly
    // matches are resolvable but never listed by /events.
    const { data, cacheKey, fromCache } = await getOrFetch({
      sport, dataType: 'results', qualifier: matchId,
      ttl: afPendingTtl(), params: { match_id: matchId },
    })

    const match = findAgentFighterMatch(data, matchId) ?? agentFighterMatches(data)[0] ?? null
    return { resolution: fromAgentFighter(sport, match), fromCache, cacheKey, dataType: 'results' }
  },
}

export const RESOLVERS: Record<string, SportResolver> = { f1, soccer, dota2, agentfighter }

export function resolverFor(sport: string): SportResolver | undefined {
  return RESOLVERS[sport]
}

// src/lib/resolve-dispatch.ts
// Maps a sport onto its event-registry and resolution mappers.
//
// The /events and /resolve routes stay sport-agnostic: they handle auth, cache,
// TTL and the response envelope, and ask this module what to fetch and how to
// normalise it. Adding a resolvable sport is a mapper plus one entry here — no
// route edits, which is the same plug-and-play rule the provider registry follows.

import { getOrFetch }        from '@/lib/serve'
import { currentSeason, recacheWithTtl, dateParams } from '@/lib/upstream'
import { qualifierFor }      from '@/lib/cache-key'
import { ttlFor }            from '@/lib/capabilities'
import { resolveProvider }   from '@/lib/providers'
import {
  fromJolpica,  eventsFromJolpica,
  fromTxLine,   eventsFromTxLine,
  fromOpenDota, eventsFromOpenDota, findDotaMatch,
  fromAgentFighter, eventsFromAgentFighter, findAgentFighterMatch, agentFighterMatches,
  fromSportradarGame,    eventsFromSportradarGames,     findSportradarGame,
  fromSportradarSummary, eventsFromSportradarSummaries, findSportradarSummary,
  RESOLVABLE,
  type Resolution, type EventRef,
} from '@/lib/resolution'

export interface EventQuery { season?: string; from?: string; to?: string }

interface SportResolver {
  /** Fetches and normalises the event registry. */
  events: (sport: string, q: EventQuery) => Promise<{ events: EventRef[]; fromCache: boolean; season: string }>
  /**
   * Fetches and normalises one event's outcome.
   *
   * A null `resolution` means "no outcome produced", and the two reasons for that
   * are NOT interchangeable — callers must be able to tell a bad id from an event
   * that simply has no result yet. The distinguishing signal is `dataType`:
   *
   *   dataType === ''  the id failed this sport's format check; nothing was
   *                    fetched. The caller's id is wrong.
   *   dataType !== ''  the upstream was queried and returned no usable outcome —
   *                    a future race, an unplayed fixture, an unknown match id.
   *                    The id may be perfectly valid; there is just nothing to
   *                    settle. Never report this as malformed.
   */
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


// ─── Sportradar ──────────────────────────────────────────────────────────────
//
// Seven sports, two resolver shapes, one shared rule about caching.
//
// ─── Why these resolvers opt out of the 30-day promotion ─────────────────────
// resolveEvent() pins a document to TTL_OFFICIAL the first time it yields an
// official result, on the reasoning that an official result never changes. That
// reasoning holds only when the document describes ONE event.
//
// Every Sportradar document here describes many: a season schedule carries a
// whole season, a daily document carries every game that day. Pinning the NBA
// season schedule for 30 days because one game finished would freeze the other
// 1,229 games in it at whatever status they happened to hold, and every
// subsequent resolution would read that frozen copy. So these resolvers return
// an EMPTY cacheKey, which is the documented opt-out, and rely on the short
// pending TTL instead. The cost is one upstream fetch per pending window per
// sport, shared across every event in it, which is cheaper than the per-event
// fetch the promotion would have saved.

/**
 * Pending-read TTL for a shared results document.
 *
 * Deliberately short and deliberately NOT the manifest TTL for these paths. The
 * season schedule is warmed weekly because it is a registry, and a registry that
 * old is fine for listing fixtures. Reading a settlement out of a seven-day-old
 * document is not: a game that finished this afternoon would still report
 * `scheduled`. The registry and the settlement read are different jobs against
 * the same document, so they get different lifetimes.
 */
const SR_PENDING_TTL = 300

/** Season-registry TTL. Matches the manifest's schedule TTL intent. */
const SR_EVENTS_TTL = 86400

/**
 * Sports whose season schedule already carries final scores.
 *
 * Verified in cache 2026-09-02: NBA, NHL and WNBA put `home_points`/`away_points`
 * on the game, and NFL puts them under `scoring`. MLB does NOT — its schedule
 * document carries no scores at any depth, so MLB alone has to go to the daily
 * document for them. Encoding that as data rather than a branch keeps the
 * resolver itself uniform.
 */
const SR_SCORES_IN_SCHEDULE = new Set(['nba', 'nhl', 'wnba', 'nfl'])

/** Builds a team-sport resolver (NBA, NHL, WNBA, NFL, MLB). */
function sportradarGameResolver(): SportResolver {
  return {
    idFormat: 'a Sportradar game id (UUID), e.g. 820c5325-360f-4b9e-a67c-77fe71338871',

    async events(sport, q) {
      const season = q.season ?? currentSeason(sport)
      const { data, fromCache } = await getOrFetch({
        sport, dataType: 'schedule', qualifier: season,
        ttl: ttlFor(sport, 'schedule', SR_EVENTS_TTL), params: { season },
      })
      return { events: eventsFromSportradarGames(sport, data), fromCache, season }
    },

    async resolve(sport, eventId) {
      const id = eventId.trim()
      // Sportradar game ids are UUIDs. Rejecting anything else here is what lets
      // resolveEvent tell a malformed id from an unknown one.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
      }

      const season = currentSeason(sport)

      // The season schedule is both the registry and, for most of these sports,
      // the results document. Read under the short pending TTL — see above.
      const { data: schedule, fromCache } = await getOrFetch({
        sport, dataType: 'schedule', qualifier: season,
        ttl: SR_PENDING_TTL, params: { season },
      })

      const game = findSportradarGame(schedule, id)
      if (!game) {
        // The upstream WAS queried and simply does not know this id in this
        // season. That is not-found, not malformed, so dataType stays non-empty.
        return { resolution: null, fromCache, cacheKey: '', dataType: 'schedule' }
      }

      if (SR_SCORES_IN_SCHEDULE.has(sport)) {
        return { resolution: fromSportradarGame(sport, game), fromCache, cacheKey: '', dataType: 'schedule' }
      }

      // MLB: the schedule knows the fixture and its status but carries no runs,
      // so the daily document is the only place the score exists. Best-effort —
      // if it cannot be read we still return the schedule's view, which reports
      // finished-without-a-score as provisional and says so in `notes` rather
      // than inventing a settlement.
      const date = game.scheduled?.split('T')[0]
      if (!date) {
        return { resolution: fromSportradarGame(sport, game), fromCache, cacheKey: '', dataType: 'schedule' }
      }

      try {
        const { data: daily } = await getOrFetch({
          sport, dataType: 'scores', qualifier: date,
          ttl: ttlFor(sport, 'scores', SR_PENDING_TTL), params: dateParams(date),
        })
        const scored = findSportradarGame(daily, id)
        if (scored) {
          return { resolution: fromSportradarGame(sport, scored), fromCache: false, cacheKey: '', dataType: 'scores' }
        }
      } catch {
        // Fall through to the schedule view. A daily-document failure must not
        // turn a resolvable event into an error.
      }

      return { resolution: fromSportradarGame(sport, game), fromCache, cacheKey: '', dataType: 'schedule' }
    },
  }
}

/**
 * Builds a unified-feed resolver (tennis, MMA).
 *
 * ─── Why the id may carry a date ────────────────────────────────────────────
 * These sports are addressed by DATE upstream: there is no per-event endpoint on
 * our key, only `/schedules/{date}/summaries.json`. A bare `sr:sport_event:...`
 * id does not say which day it belongs to, so resolving one means knowing the
 * date or searching for it.
 *
 * Both are supported. `{id}@{YYYY-MM-DD}` goes straight to that day and costs one
 * read, and it is what /events hands back, so a market that bound to the registry
 * always has it. A bare id falls back to scanning recent days, newest first, and
 * stops at the first hit.
 *
 * The scan window is bounded per sport for a reason that is about money, not
 * neatness: MMA's monthly quota is 2,500 calls, so an unbounded search would be a
 * way to drain a month of it with a handful of wrong ids. Days already in cache
 * cost nothing, which is why the window can be as wide as it is.
 */
function sportradarSummaryResolver(lookbackDays: number): SportResolver {
  return {
    idFormat: 'a Sportradar event id, optionally with its date — sr:sport_event:74124796 or sr:sport_event:74124796@2026-09-02',

    async events(sport, q) {
      const date = (q.from ?? new Date().toISOString()).split('T')[0]
      const { data, fromCache } = await getOrFetch({
        sport, dataType: 'schedule', qualifier: date,
        ttl: ttlFor(sport, 'schedule', 3600), params: dateParams(date),
      })
      // The registry emits ids carrying their date, so a consumer that binds a
      // market here can resolve it later in a single read.
      const events = eventsFromSportradarSummaries(sport, data)
        .map(e => ({ ...e, event_id: `${e.event_id}@${date}` }))
      return { events, fromCache, season: currentSeason(sport) }
    },

    async resolve(sport, eventId) {
      const [rawId, pinnedDate] = eventId.trim().split('@')
      if (!/^sr:sport_event:\d+$/.test(rawId)) {
        return { resolution: null, fromCache: false, cacheKey: '', dataType: '' }
      }

      const days: string[] = []
      if (pinnedDate && /^\d{4}-\d{2}-\d{2}$/.test(pinnedDate)) {
        days.push(pinnedDate)
      } else {
        for (let i = 0; i < lookbackDays; i++) {
          days.push(new Date(Date.now() - i * 86400000).toISOString().split('T')[0])
        }
      }

      for (const date of days) {
        try {
          const { data, fromCache } = await getOrFetch({
            sport, dataType: 'scores', qualifier: date,
            ttl: ttlFor(sport, 'scores', SR_PENDING_TTL), params: dateParams(date),
          })
          const found = findSportradarSummary(data, rawId)
          if (found) {
            return { resolution: fromSportradarSummary(sport, found), fromCache, cacheKey: '', dataType: 'scores' }
          }
        } catch {
          // A single bad day must not abort the search.
        }
      }

      // Searched and did not find it: not-found rather than malformed.
      return { resolution: null, fromCache: false, cacheKey: '', dataType: 'scores' }
    },
  }
}

export const RESOLVERS: Record<string, SportResolver> = {
  f1, soccer, dota2, agentfighter,

  // Sportradar. Built from two factories rather than seven literals because the
  // sports differ only in payload family and, for the unified feed, in how far
  // back a bare id may be searched.
  nba:  sportradarGameResolver(),
  nhl:  sportradarGameResolver(),
  wnba: sportradarGameResolver(),
  nfl:  sportradarGameResolver(),
  mlb:  sportradarGameResolver(),

  // 3 days: tennis runs daily, so a recently-completed match is close by.
  tennis: sportradarSummaryResolver(3),
  // 8 days: MMA runs weekly cards, so yesterday is usually empty and the last
  // card can be a week back. Cached days cost nothing, and the quota here is
  // 2,500/month, which is exactly why this is bounded at all.
  mma:    sportradarSummaryResolver(8),
}

/**
 * Fails loudly at module load if RESOLVABLE and RESOLVERS disagree.
 *
 * The two lists have to be maintained in different files (resolution.ts cannot
 * import this module without a cycle), and they are read by different callers:
 * RESOLVABLE is what /events and /resolve advertise as supported, RESOLVERS is
 * what actually answers. A drift between them is a bad failure — a sport
 * advertised as settleable that 404s, or one that works but is never mentioned —
 * and it is silent, because nothing in a request path compares them.
 *
 * Checking at import time turns that into a build/boot error instead.
 */
function assertResolvableMatchesResolvers(): void {
  const declared = [...RESOLVABLE].sort().join(',')
  const actual   = Object.keys(RESOLVERS).sort().join(',')
  if (declared !== actual) {
    throw new Error(
      `resolution.RESOLVABLE and resolve-dispatch.RESOLVERS disagree.
`
      + `  RESOLVABLE: ${declared}
`
      + `  RESOLVERS:  ${actual}
`
      + `Add the sport to both, or remove it from both.`
    )
  }
}
assertResolvableMatchesResolvers()

export function resolverFor(sport: string): SportResolver | undefined {
  return RESOLVERS[sport]
}

/** An official result is immutable, so it never needs fetching twice. */
const TTL_OFFICIAL = 2592000  // 30 days

export type ResolveOutcome =
  | { ok: false; reason: 'unsupported'; supported: string[] }
  | { ok: false; reason: 'malformed';   idFormat: string }
  | { ok: false; reason: 'not_found' }
  | { ok: true;  resolution: Resolution; fromCache: boolean }

/**
 * Resolve one event, end to end: per-sport id validation, normalisation, and the
 * cache-lifetime promotion that follows a result becoming official.
 *
 * Every transport must go through here. The MCP route previously re-implemented
 * this by fetching `endpoint.dataType` directly, which silently reintroduced the
 * exact class of bug this module exists to prevent: a single F1-shaped id parser
 * applied to every sport, no normalisation, and a `settleable` flag copied from a
 * static provider capability instead of the resolved outcome — so a race that had
 * not happened yet still reported as settleable. One implementation, two
 * transports; adding a third must not mean writing this a third time.
 */
export async function resolveEvent(sport: string, eventId: string): Promise<ResolveOutcome> {
  const resolver = resolverFor(sport)
  if (!resolver) return { ok: false, reason: 'unsupported', supported: Object.keys(RESOLVERS) }

  const { resolution, cacheKey, fromCache, dataType, data } = await resolver.resolve(sport, eventId)

  if (!resolution) {
    // An id that never reached the upstream is malformed; one that did and came
    // back empty is simply not settleable yet. Reporting a future race as
    // "malformed" sent integrators hunting for a bug in their own id handling.
    return dataType
      ? { ok: false, reason: 'not_found' }
      : { ok: false, reason: 'malformed', idFormat: resolver.idFormat }
  }

  // Promote to the long TTL the first time we see an official result. Only on a
  // fresh fetch — a cache hit is already holding the right lifetime. Resolvers
  // that hand back an empty cacheKey (rolling feeds) opt out deliberately;
  // pinning those would freeze the registry.
  if (resolution.official && !fromCache && cacheKey) {
    const provider = resolveProvider(sport, dataType)
    if (provider && data && typeof data === 'object') {
      recacheWithTtl(sport, dataType, cacheKey, data as Record<string, unknown>, TTL_OFFICIAL, provider.id)
    }
  }

  return { ok: true, resolution, fromCache }
}

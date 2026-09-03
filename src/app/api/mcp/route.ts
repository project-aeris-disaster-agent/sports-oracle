// src/app/api/mcp/route.ts
// MCP over HTTP — JSON-RPC interface for AI agents.
// Auth: same X-Oracle-Key as the REST API.
//
// Tools are DERIVED from the capability manifest rather than hand-written. The
// previous version maintained an eleven-case switch in parallel with the REST
// routes, and the two had drifted into real bugs: tools advertised sports whose
// endpoint maps had no matching entry (get_scores for NFL, get_events for
// anything but MMA, get_roster for MMA), every one of which threw at runtime.
// Deriving the list means an endpoint that does not exist cannot be advertised.
//
// This also routes through gateway() and getOrFetch() like every other surface,
// which fixes two further gaps: MCP previously bypassed the per-tier rate limiter
// entirely, and logged every call as a cache miss with 0ms latency.

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit }                 from '@upstash/ratelimit'
import { Redis }                     from '@upstash/redis'
import { gateway }                   from '@/middleware/gateway'
import { getOrFetch, logRequest }    from '@/lib/serve'
import { currentSeason, dateParams } from '@/lib/upstream'
import { qualifierFor }              from '@/lib/cache-key'
import {
  ENTITLED_SPORTS, getSport, getEndpoint, supportedFor, endpointSource, toolCatalog,
} from '@/lib/capabilities'
import { resolverFor, resolveEvent, RESOLVERS } from '@/lib/resolve-dispatch'
import { readSettlementFeed }        from '@/lib/settlement-feed'
import { isOpenAndFree }             from '@/lib/providers'
import { sandboxPayload }            from '@/lib/sandbox'

// ─── Tool definitions, derived ────────────────────────────────────────────────

const PARAM_DESC: Record<string, string> = {
  season:      'Season year, e.g. "2026". Defaults to the current season.',
  date:        'Date as YYYY-MM-DD. Defaults to today.',
  week:        'NFL week number. Defaults to 1.',
  round:       'Race round number within the season.',
  game_id:     'Game identifier, from get_schedule or get_scores.',
  team_id:     'Team identifier, from get_teams.',
  race_id:     'Race identifier.',
  session_key: 'OpenF1 session key. Defaults to "latest".',
  event_id:    'Event identifier from get_events, e.g. "2026-1".',
}

interface Tool {
  name:        string
  description: string
  path:        string
  inputSchema: Record<string, unknown>
}

function buildTools(): Tool[] {
  // toolCatalog() is shared with the landing page, so the tools advertised there
  // and the tools served here are the same list by construction.
  return toolCatalog().map(({ name, path, spec }) => {
    const sports = supportedFor(path)

    const properties: Record<string, unknown> = {
      sport: { type: 'string', enum: sports, description: `One of: ${sports.join(', ')}` },
    }
    const required = ['sport']

    for (const p of spec.params) {
      const optional = p.endsWith('?')
      const name     = optional ? p.slice(0, -1) : p
      properties[name] = { type: 'string', description: PARAM_DESC[name] ?? name }
      if (!optional) required.push(name)
    }

    const tierNote = spec.minTier && spec.minTier !== 'scout'
      ? ` Requires ${spec.minTier} tier or above.`
      : ''

    return {
      name,
      path,
      description: `${spec.desc}.${spec.signal ? ` ${spec.signal}` : ''}${tierNote}`,
      inputSchema: { type: 'object', properties, required },
    }
  })
}

const TOOLS = buildTools()
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]))

const TIER_RANK = { scout: 0, analyst: 1, oracle: 2 } as const

// ─── Discovery rate limit ─────────────────────────────────────────────────────
// initialize/tools/list are unauthenticated, so they sit outside the gateway's
// per-account limiter and need their own bound. Keyed by IP and deliberately
// generous — a legitimate client handshakes once per session, while this still
// denies anyone trying to use an open endpoint as a load generator. Both
// responses are static, so this costs one Redis command and no upstream work.
const discoveryLimiter = new Ratelimit({
  redis:   new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  prefix:  'rl:mcp:discovery',
})

/** Returns a 429 response when the caller has exhausted the discovery budget. */
async function limitDiscovery(req: NextRequest): Promise<NextResponse | null> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const { success, reset } = await discoveryLimiter.limit(ip)
  if (success) return null

  return NextResponse.json(
    { error: 'Too many discovery requests.', code: 'rate_limited' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))) },
    }
  )
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

interface ToolOutcome { text: string; cacheHit: boolean; status: number }

function fail(message: string, status = 400, extra: object = {}): ToolOutcome {
  return { text: JSON.stringify({ error: message, ...extra }), cacheHit: false, status }
}

function ok(payload: object, cacheHit: boolean): ToolOutcome {
  return { text: JSON.stringify(payload), cacheHit, status: 200 }
}

/**
 * Provider provenance. `supports_settlement` is a CAPABILITY of the source — "is
 * this an authority we would settle from" — and is constant per provider.
 *
 * It was previously called `settleable`, which read as a per-event verdict and
 * was consumed as one: it returned true for a race that had not been run, so a
 * market gating on it would have settled an unresolved event. The per-event
 * answer is `meta.settleable`, computed from the resolved outcome, and it exists
 * only on /resolve — because it is the only place the question has an answer.
 */
function sourceOf(sport: string, path: string) {
  const src = endpointSource(sport, path)
  return src && {
    provider: src.id,
    label:    src.label,
    license:  src.license,
    supports_settlement: src.authoritative,
  }
}

/**
 * The resolution surface, delegated to the shared dispatcher.
 *
 * Everything here used to be served by the generic path below, which fetched
 * `endpoint.dataType` straight from the provider. That produced four separate
 * defects at once: a single F1-shaped id parser rejected soccer/dota2/agentfighter
 * ids, `get_events` returned raw upstream bodies despite advertising a normalised
 * registry, `get_resolve` demanded a `match_id` the public schema had no way to
 * supply, and settleability came from a static provider flag. Delegating fixes all
 * four at the source rather than papering over each symptom.
 */
async function handleResolution(
  path: 'events' | 'resolve',
  sport: string,
  args: Record<string, string>,
  sandbox: boolean
): Promise<ToolOutcome> {
  const resolver = resolverFor(sport)
  if (!resolver) {
    return fail('Resolution is not available for this sport.', 404, {
      code: 'resolution_unsupported',
      supported: Object.keys(RESOLVERS),
    })
  }

  // A normalised outcome has no synthetic equivalent — fabricating a settlement
  // would be worse than refusing one — so a sandbox key is refused on licensed
  // sources rather than served real licensed data. The open sources stay fully
  // available, which is most of the settlement surface, so a free integration
  // can still be rehearsed end to end.
  if (sandbox && !isOpenAndFree(sport, 'results')) {
    return fail(
      `Settlement data for ${getSport(sport)?.label ?? sport} comes from a licensed source and is not available on a sandbox key.`,
      403,
      {
        code: 'sandbox_licensed_source',
        sandboxAvailable: Object.keys(RESOLVERS).filter(s => isOpenAndFree(s, 'results')),
      }
    )
  }

  if (path === 'events') {
    const { events: all, fromCache, season } = await resolver.events(sport, {
      season: args.season, from: args.from, to: args.to,
    })

    // Same window filter the REST route applies, so both transports return the
    // same set for the same arguments.
    let events = all
    if (args.from) events = events.filter(e => !e.scheduled_at || e.scheduled_at >= args.from)
    if (args.to)   events = events.filter(e => !e.scheduled_at || e.scheduled_at <= args.to)

    return ok({
      sport, season, count: events.length, events,
      meta: { source: fromCache ? 'cache' : 'origin', ...sourceOf(sport, 'events') },
    }, fromCache)
  }

  const eventId = args.event_id
  if (!eventId) {
    return fail('event_id is required. Get one from get_events.', 400, { code: 'missing_param' })
  }

  const outcome = await resolveEvent(sport, eventId)

  if (!outcome.ok) {
    if (outcome.reason === 'unsupported') {
      return fail('Resolution is not available for this sport.', 404,
        { code: 'resolution_unsupported', supported: outcome.supported })
    }
    if (outcome.reason === 'malformed') {
      return fail('Malformed event_id.', 400,
        { code: 'malformed_event_id', event_id: eventId, expected: outcome.idFormat })
    }
    // Valid id, no outcome yet — a future event, or one this source has never
    // heard of. Carries meta.settleable so a market gating on that field gets an
    // explicit false here rather than an absent key it has to interpret.
    return fail('No result available for this event yet.', 404, {
      code: 'event_not_found',
      event_id: eventId,
      meta: { settleable: false, status: 'unknown' },
    })
  }

  const { resolution, fromCache } = outcome

  return ok({
    sport,
    event_id: eventId,
    resolution,
    // Per-event, computed from the outcome — NOT a provider capability. An event
    // that has not happened, or has no official classification yet, is false here.
    meta: {
      source:     fromCache ? 'cache' : 'origin',
      settleable: resolution.official,
      status:     resolution.status,
      note: resolution.official
        ? (resolution.void_reason
            ? `Void (${resolution.void_reason}) — no result. Safe to settle as void.`
            : 'Official result. Safe to settle.')
        : `NOT settleable — status is "${resolution.status}".`,
      ...sourceOf(sport, 'resolve'),
    },
  }, fromCache)
}

async function handleTool(
  tool: Tool,
  args: Record<string, string>,
  tier: keyof typeof TIER_RANK,
  sandbox: boolean
): Promise<ToolOutcome> {
  const sport = args.sport?.toLowerCase()
  if (!sport) return fail('sport is required.', 400, { code: 'missing_param' })

  // Resolve against the manifest FIRST, and only ever echo values that came back
  // from it. Reflecting the caller's raw `sport` into the message put attacker-
  // controlled text in an error string; every identifier below is now ours.
  const spec = getSport(sport)
  if (!spec) {
    return fail('Unknown sport.', 404,
      { code: 'unknown_sport', supported: ENTITLED_SPORTS.map(s => s.key) })
  }
  if (!spec.entitled) {
    return fail(`${spec.label} is not available on this plan.`, 404,
      { code: 'sport_unavailable', sport: spec.key, supported: ENTITLED_SPORTS.map(s => s.key) })
  }

  const endpoint = getEndpoint(sport, tool.path)
  if (!endpoint) {
    return fail(`${tool.name} is not available for ${spec.label}.`, 404,
      { code: 'endpoint_unavailable', sport: spec.key, supported: supportedFor(tool.path) })
  }

  // Tier gate, mirroring the REST preflight checks. Names the TOOL, not the
  // endpoint description — interpolating the description made get_verify's
  // denial read as a dump of its own docs rather than an access decision.
  //
  // Sandbox keys pass deliberately, exactly as they do on REST: they receive
  // synthetic data (below), which costs no quota and exposes nothing licensed,
  // so blocking them would stop a free user rehearsing the very in-play
  // integration the paid tier exists to serve. That exemption is only sound
  // BECAUSE the synthetic short-circuit below exists — do not keep one without
  // the other.
  const need = endpoint.minTier ?? 'scout'
  if (!sandbox && TIER_RANK[tier] < TIER_RANK[need]) {
    return fail(`${tool.name} requires ${need} tier or above.`, 403,
      { code: 'tier_required', required: need, tier, sandboxAvailable: true })
  }

  // The resolution surface is normalised and per-sport; it must not be served by
  // the generic pass-through below. See handleResolution.
  if (tool.path === 'events' || tool.path === 'resolve') {
    return handleResolution(tool.path, sport, args, sandbox)
  }

  // The settlement feed is read from our own observation log, never from an
  // upstream. Sent to the generic fetch below it would have asked Sportradar for
  // a dataType called "settlements". Same sandbox rule as resolve: licensed
  // outcomes are not shown to a free key.
  if (tool.path === 'settlements') {
    if (!resolverFor(sport)) {
      return fail('Settlement feed is not available for this sport.', 404,
        { code: 'resolution_unsupported', supported: Object.keys(RESOLVERS) })
    }
    if (sandbox && !isOpenAndFree(sport, 'results')) {
      return fail(`Settlement data for ${getSport(sport)?.label ?? sport} comes from a licensed source and is not available on a sandbox key.`,
        403, { code: 'sandbox_licensed_source', sandboxAvailable: Object.keys(RESOLVERS).filter(s => isOpenAndFree(s, 'results')) })
    }
    const feed = await readSettlementFeed(sport, {
      since: args.since, revised: args.revised === 'true', official: args.official === 'true', limit: args.limit,
    })
    return feed.ok ? ok(feed.body, true) : fail(feed.error, feed.error.startsWith('since must') ? 400 : 500)
  }

  const date = args.date ?? new Date().toISOString().split('T')[0]

  // Documented as "Defaults to 1", and the REST route applies that default — but
  // this transport did not, so the upstream path template hit an unfilled {week}
  // and failed on a parameter the schema advertises as optional.
  const week = args.week ?? '1'

  // event_id is the resolution surface's addressing scheme; unpack it into the
  // season/round the upstream actually wants.
  //
  // It carries BOTH halves. Taking only the round and letting season fall through
  // to the current season silently resolves the wrong race — asking for 2024-2
  // returned the 2026 round 2 result, with an `official: true` flag on it.
  let round  = args.round
  let season = args.season ?? currentSeason(sport)
  if (args.event_id) {
    const m = /^(\d{4})-(\d{1,2})/.exec(args.event_id)
    if (!m) return fail(`Malformed event_id "${args.event_id}". Expected {season}-{round}.`)
    season = m[1]
    round  = m[2]
  }

  const keyArgs = {
    season, date, round, week,
    game_id:     args.game_id,
    team_id:     args.team_id,
    race_id:     args.race_id,
    session_key: args.session_key ?? 'latest',
  }

  // Required params the caller omitted — caught here rather than as an opaque
  // upstream 400 twenty lines deeper.
  for (const p of endpoint.params) {
    if (p.endsWith('?')) continue
    const name = p === 'event_id' ? 'event_id' : p
    if (!args[name]) return fail(`${name} is required for ${tool.name}.`)
  }

  const qualifier = qualifierFor(sport, tool.path, keyArgs)

  // Sandbox short-circuit — the same contract serveCached enforces for REST.
  // Its absence here was a real licence and cost leak: a free scout key calling
  // this transport received genuine licensed Sportradar payloads and spent paid
  // quota to fetch them, while the identical REST call correctly returned
  // synthetic data. Open, unmetered sources stay live because there is nothing
  // to protect (see isOpenAndFree).
  if (sandbox && !isOpenAndFree(sport, endpoint.dataType)) {
    return ok({
      data: sandboxPayload(sport, endpoint.dataType, qualifier),
      _source: sourceOf(sport, tool.path),
      meta: {
        source: 'sandbox', sandbox: true,
        note: 'Synthetic data — shapes match production. Stake $DARE to unlock live data.',
      },
    }, true)
  }

  try {
    const { data, fromCache } = await getOrFetch({
      sport,
      dataType:  endpoint.dataType,
      qualifier,
      ttl:       endpoint.ttl,
      params:    { ...dateParams(date), season, round: round ?? '', week, ...args },
    })

    // Provenance travels with MCP responses too — an agent reasoning about
    // whether it may settle on this data needs the same facts a REST caller gets.
    return ok({ data, _source: sourceOf(sport, tool.path) }, fromCache)
  } catch (err) {
    const msg    = err instanceof Error ? err.message : 'Tool error'
    const status = (err as { status?: number }).status ?? 502
    return fail(msg, status)
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, string> } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const method = body.method

  // ─── Public discovery ───────────────────────────────────────────────────────
  // `initialize` and `tools/list` describe the server; they return no sports data
  // and no per-key state, so they need no key. Requiring one made the server
  // undiscoverable: an MCP client performs the handshake BEFORE it has anywhere
  // to put credentials, so an unkeyed agent could not even learn that a key was
  // what it was missing. The tool catalogue is derived from the same manifest the
  // public landing page already renders, so this discloses nothing new.
  //
  // Everything that touches live data still requires a key — see below.
  if (method === 'initialize' || method === 'tools/list') {
    const limited = await limitDiscovery(req)
    if (limited) return limited

    if (method === 'initialize') {
      return NextResponse.json({
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'sports-oracle', version: '2.1.0' },
        // Surfaced in the handshake so an agent learns the auth requirement at
        // discovery time rather than by failing its first real call.
        instructions:
          'Public discovery: initialize and tools/list need no credentials. ' +
          'Every tools/call requires an API key via the X-Oracle-Key header ' +
          '(or Authorization: Bearer). Tier governs access: scout is free, ' +
          'analyst and above unlock live and in-play tools. ' +
          'Settlement: only settle when meta.settleable is true — it is computed ' +
          'per event, so an unfinished or unknown event returns false.',
      })
    }

    return NextResponse.json({
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
  }

  // ─── Everything below returns data — authenticate ───────────────────────────
  // Same gateway as REST. Sport is null because it arrives in the tool arguments;
  // the mask is enforced per call below.
  const auth = await gateway(req, null)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  if (method === 'tools/call') {
    const start    = Date.now()
    const toolName = body.params?.name
    const toolArgs = body.params?.arguments ?? {}

    if (!toolName) {
      return NextResponse.json({ error: 'params.name required' }, { status: 400 })
    }

    const tool = BY_NAME.get(toolName)
    if (!tool) {
      return NextResponse.json({
        content: [{ type: 'text', text: JSON.stringify({
          error: `Unknown tool: ${toolName}`, available: TOOLS.map(t => t.name),
        })}],
      })
    }

    // Entitlement check. Only ever names a sport the manifest recognises — the
    // caller's raw value is never echoed, so a hostile `sport` cannot ride out in
    // an error string a client might render.
    const sport = toolArgs.sport?.toLowerCase()
    const known = sport ? getSport(sport) : undefined
    if (sport && (!known || !context.sportMask.includes(known.key))) {
      return NextResponse.json({
        content: [{ type: 'text', text: JSON.stringify(
          known
            ? { error: `Your key does not include ${known.label} access.`,
                code: 'sport_not_entitled', sport: known.key }
            : { error: 'Unknown sport.', code: 'unknown_sport',
                supported: ENTITLED_SPORTS.map(s => s.key) }
        )}],
      })
    }

    const outcome = await handleTool(tool, toolArgs, context.tier, context.sandbox)

    // Real cache-hit and latency figures. These were previously hardcoded to
    // false/0, which made every MCP call look like a miss in usage analytics.
    logRequest(
      context, sport ?? 'unknown', `mcp:${toolName}`,
      outcome.cacheHit, Date.now() - start, outcome.status
    )

    return NextResponse.json({ content: [{ type: 'text', text: outcome.text }] })
  }

  return NextResponse.json({ error: `Unknown method: ${method}` }, { status: 400 })
}

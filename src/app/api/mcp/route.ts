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
import { gateway }                   from '@/middleware/gateway'
import { getOrFetch, logRequest }    from '@/lib/serve'
import { currentSeason, dateParams } from '@/lib/upstream'
import { qualifierFor }              from '@/lib/cache-key'
import {
  ENTITLED_SPORTS, getSport, getEndpoint, supportedFor, endpointSource, toolCatalog,
} from '@/lib/capabilities'

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

// ─── Dispatch ─────────────────────────────────────────────────────────────────

interface ToolOutcome { text: string; cacheHit: boolean; status: number }

function fail(message: string, status = 400, extra: object = {}): ToolOutcome {
  return { text: JSON.stringify({ error: message, ...extra }), cacheHit: false, status }
}

async function handleTool(
  tool: Tool,
  args: Record<string, string>,
  tier: keyof typeof TIER_RANK
): Promise<ToolOutcome> {
  const sport = args.sport?.toLowerCase()
  if (!sport) return fail('sport is required.')

  const spec = getSport(sport)
  if (!spec || !spec.entitled) {
    return fail(`${sport.toUpperCase()} is not available.`, 404,
      { supported: ENTITLED_SPORTS.map(s => s.key) })
  }

  const endpoint = getEndpoint(sport, tool.path)
  if (!endpoint) {
    return fail(`${tool.name} is not available for ${sport.toUpperCase()}.`, 404,
      { supported: supportedFor(tool.path) })
  }

  // Tier gate, mirroring the REST preflight checks.
  const need = endpoint.minTier ?? 'scout'
  if (TIER_RANK[tier] < TIER_RANK[need]) {
    return fail(`${endpoint.desc} requires ${need} tier or above.`, 403)
  }

  const date = args.date ?? new Date().toISOString().split('T')[0]

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
    season, date, round,
    week:        args.week,
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

  try {
    const { data, fromCache } = await getOrFetch({
      sport,
      dataType:  endpoint.dataType,
      qualifier,
      ttl:       endpoint.ttl,
      params:    { ...dateParams(date), season, round: round ?? '', ...args },
    })

    const src = endpointSource(sport, tool.path)
    return {
      // Provenance travels with MCP responses too — an agent reasoning about
      // whether it may settle on this data needs the same facts a REST caller gets.
      text: JSON.stringify({
        data,
        _source: src && {
          provider: src.id, label: src.label, license: src.license,
          settleable: src.authoritative,
        },
      }),
      cacheHit: fromCache,
      status:   200,
    }
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

  // Authenticate and rate-limit through the same gateway as REST. Sport is null
  // because it arrives in the tool arguments; the mask is enforced per call below.
  const auth = await gateway(req, null)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  if (method === 'initialize') {
    return NextResponse.json({
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      serverInfo:      { name: 'sports-oracle', version: '2.0.0' },
    })
  }

  if (method === 'tools/list') {
    return NextResponse.json({
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
  }

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

    const sport = toolArgs.sport?.toLowerCase()
    if (sport && !context.sportMask.includes(sport)) {
      return NextResponse.json({
        content: [{ type: 'text', text: JSON.stringify({
          error: `Your key does not include ${sport.toUpperCase()} access.`,
        })}],
      })
    }

    const outcome = await handleTool(tool, toolArgs, context.tier)

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

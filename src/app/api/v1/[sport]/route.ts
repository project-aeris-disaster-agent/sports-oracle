// src/app/api/v1/[sport]/route.ts
// Per-sport capability manifest.
//
// GET /api/v1/nba  ->  everything NBA supports, with params, TTLs and tier gates.
//
// This exists so an agent can discover a sport's surface at runtime instead of
// hardcoding assumptions that differ per sport (tennis has no roster, NFL scopes
// injuries by week, MMA is event-based). Pure metadata — never calls Sportradar,
// so it costs nothing against the monthly budget.

import { NextRequest, NextResponse } from 'next/server'
import { gateway }                   from '@/middleware/gateway'
import { getSport, SPORTS, endpointSource } from '@/lib/capabilities'

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const spec  = getSport(sport)

  if (!spec) {
    return NextResponse.json(
      { error: `Unknown sport "${sport}".`, supported: SPORTS.map(s => s.key) },
      { status: 404 }
    )
  }

  // Auth still applies — the manifest reveals what a key can reach.
  const auth = await gateway(req, sport)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  if (!spec.entitled) {
    return NextResponse.json(
      {
        sport: spec.key,
        entitled: false,
        error: `${spec.label} is not available on this plan.`,
        note: spec.note,
      },
      { status: 403 }
    )
  }

  const tierRank = { scout: 0, analyst: 1, oracle: 2 }
  const myRank   = tierRank[context.tier]

  return NextResponse.json({
    sport:      spec.key,
    label:      spec.label,
    entitled:   true,
    teamBased:  spec.teamBased,
    season:     spec.season,
    note:       spec.note,
    yourTier:   context.tier,
    // Upstream provenance for the whole sport. An agent deciding whether to build
    // on this data needs to know where it comes from and whether it can settle a
    // market — not just what the endpoint is called.
    sources:    spec.sources,
    // Selectable upstreams. Pass ?provider=<id> on any endpoint below to route
    // there instead of the default. Offline entries are listed on purpose: a
    // router should publish what it could route to, not just what it does today.
    providers: {
      default:   spec.sources.find(s => s.isDefault)?.id,
      selectVia: '?provider=<id>',
      options:   spec.sources.map(s => ({
        id:        s.id,
        label:     s.label,
        status:    s.status,
        license:   s.license,
        available: s.status === 'live',
        settleable: s.authoritative,
        reason:    s.offlineReason,
        homepage:  s.homepage,
      })),
    },
    endpoints:  spec.endpoints.map(e => {
      const src = endpointSource(spec.key, e.path)
      return {
        url:        `/api/v1/${spec.key}/${e.path}`,
        params:     e.params,
        minTier:    e.minTier ?? 'scout',
        accessible: myRank >= tierRank[e.minTier ?? 'scout'],
        description: e.desc,
        bettingSignal: e.signal,
        // Per-endpoint, because one sport can draw from several upstreams —
        // F1 settles on Jolpica but streams live from OpenF1.
        source:     src?.id,
        sourceLabel: src?.label,
        settleable: src?.authoritative ?? false,
      }
    }),
  })
}

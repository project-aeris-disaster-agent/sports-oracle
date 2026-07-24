// src/app/api/v1/[sport]/[resource]/route.ts
// Generic manifest-driven endpoint.
//
// Any endpoint declared in capabilities.ts is reachable through here without a
// route file of its own — dataType, TTL, tier gate, cache qualifier and required
// params all come from the manifest. This is what makes adding a sport or an
// endpoint genuinely plug-and-play: a provider file plus a manifest entry, and
// the HTTP surface follows.
//
// Next.js resolves static segments before dynamic ones, so the hand-written
// routes (/scores, /live, /injuries, /resolve, …) still take precedence. Those
// exist because they carry real per-sport logic — window guards, adaptive TTLs,
// week scoping. This handles the plain ones.

import { NextRequest, NextResponse } from 'next/server'
import { serveCached }               from '@/lib/serve'
import { currentSeason, dateParams } from '@/lib/upstream'
import { getSport, getEndpoint }     from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'
import { checkParams }               from '@/lib/params'
import { TIERS }                     from '@/lib/tiers'

const TIER_RANK = { scout: 0, analyst: 1, oracle: 2 } as const

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string; resource: string } }
) {
  const sport    = params.sport.toLowerCase()
  const resource = params.resource.toLowerCase()

  const spec = getSport(sport)
  if (!spec) {
    return NextResponse.json({ error: `Unknown sport "${sport}".` }, { status: 404 })
  }

  const endpoint = getEndpoint(sport, resource)
  if (!endpoint) {
    return NextResponse.json(
      {
        error: `${spec.label} has no "${resource}" endpoint.`,
        available: spec.endpoints.map(e => e.path),
      },
      { status: 404 }
    )
  }

  const qs     = new URL(req.url).searchParams
  const season = qs.get('season') ?? currentSeason(sport)
  const date   = qs.get('date')   ?? new Date().toISOString().split('T')[0]

  // Required params are declared in the manifest ('foo' required, 'foo?' optional),
  // so the check is derived rather than restated per route.
  const missing = endpoint.params
    .filter(p => !p.endsWith('?'))
    .map(p => p.replace(/\?$/, ''))
    .filter(p => !qs.get(p))

  if (missing.length) {
    return NextResponse.json(
      { error: `Missing required parameter(s): ${missing.join(', ')}.`, endpoint: `/api/v1/${sport}/${resource}` },
      { status: 400 }
    )
  }

  const args = {
    season, date,
    week:        qs.get('week')        ?? undefined,
    round:       qs.get('round')       ?? undefined,
    game_id:     qs.get('game_id')     ?? undefined,
    team_id:     qs.get('team_id')     ?? undefined,
    race_id:     qs.get('race_id')     ?? undefined,
    session_key: qs.get('session_key') ?? undefined,
    fixture_id:  qs.get('fixture_id')  ?? undefined,
    epoch_day:   qs.get('epoch_day')   ?? undefined,
  }

  // Shape-check ids before spending an upstream call. A malformed id otherwise
  // produces a real metered request that returns 404 — see lib/params.ts.
  const bad = checkParams(args)
  if (bad) {
    return NextResponse.json(
      {
        error: `Invalid "${bad.param}" — expected ${bad.expected}.`,
        received: bad.value,
      },
      { status: 400 }
    )
  }

  const needed = endpoint.minTier ?? 'scout'

  return serveCached({
    req,
    sport,
    dataType:  endpoint.dataType,
    qualifier: qualifierFor(sport, resource, args),
    ttl:       endpoint.ttl,
    params:    { ...dateParams(date), season },
    preflight: (ctx) => {
      if (!spec.entitled) {
        return NextResponse.json(
          { error: `${spec.label} is not currently available.`, note: spec.note },
          { status: 403 }
        )
      }
      // Sandbox keys pass tier gates deliberately — they receive synthetic data,
      // which costs no quota and exposes nothing licensed.
      if (!ctx.sandbox && TIER_RANK[ctx.tier] < TIER_RANK[needed]) {
        return NextResponse.json(
          {
            error: `${endpoint.desc} requires ${needed} tier. Stake ${TIERS[needed].stake.toLocaleString()} $DARE to unlock.`,
            sandboxAvailable: true,
          },
          { status: 403 }
        )
      }
      return null
    },
  })
}

// src/app/api/v1/[sport]/pbp/route.ts
// Play-by-play — the event stream in-play markets are priced from.
//
// Tier-gated with live data: PBP is the same real-time signal, so scout is
// blocked here for the same reason it's blocked on /live.

import { NextRequest, NextResponse } from 'next/server'
import { serveCached }               from '@/lib/serve'
import { TIERS }                     from '@/lib/tiers'
import { supportedFor, ttlFor }      from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'
import { checkParams }               from '@/lib/params'

const SUPPORTED = supportedFor('pbp')

// Short TTL: an in-progress game's PBP is append-only and changes constantly.
const TTL_FALLBACK = 30

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const gameId = searchParams.get('game_id')

  return serveCached({
    req,
    sport,
    dataType:  'pbp',
    qualifier: qualifierFor(sport, 'pbp', { game_id: gameId ?? undefined }),
    ttl:       ttlFor(sport, 'pbp', TTL_FALLBACK),
    params:    { game_id: gameId ?? '' },
    preflight: (ctx) => {
      if (!SUPPORTED.includes(sport)) {
        return NextResponse.json(
          { error: `Play-by-play is not available for ${sport.toUpperCase()}.`, supported: SUPPORTED },
          { status: 404 }
        )
      }
      if (!gameId) {
        return NextResponse.json({ error: 'game_id is required.' }, { status: 400 })
      }
      const badParam = checkParams({ game_id: gameId })
      if (badParam) {
        return NextResponse.json(
          { error: `Invalid "game_id" — expected ${badParam.expected}.`, received: badParam.value },
          { status: 400 }
        )
      }
      // Sandbox keys pass the tier gate deliberately: they receive synthetic
      // play-by-play, which costs no quota and exposes no licensed data. Blocking
      // them would stop a free user rehearsing the exact in-play integration the
      // paid tier exists to serve.
      if (!ctx.sandbox && ctx.tier === 'scout') {
        return NextResponse.json(
          {
            error: `Play-by-play requires Analyst tier. Stake ${TIERS.analyst.stake.toLocaleString()} $DARE to unlock live data.`,
            sandboxAvailable: true,
          },
          { status: 403 }
        )
      }
      return null
    },
  })
}

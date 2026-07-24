// src/app/api/v1/[sport]/leaders/route.ts
// Statistical leaders — the base rates player-prop lines are modelled against.

import { NextRequest, NextResponse } from 'next/server'
import { currentSeason }             from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { supportedFor, ttlFor }      from '@/lib/capabilities'

const SUPPORTED = supportedFor('leaders')

// Season aggregates move slowly; refresh daily.
const TTL_FALLBACK = 86400

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const season = searchParams.get('season') ?? currentSeason(sport)

  return serveCached({
    req,
    sport,
    dataType:  'leaders',
    qualifier: season,
    ttl:       ttlFor(sport, 'leaders', TTL_FALLBACK),
    params:    { season },
    preflight: () =>
      SUPPORTED.includes(sport)
        ? null
        : NextResponse.json(
            {
              error: `Statistical leaders are not available for ${sport.toUpperCase()}.`,
              supported: SUPPORTED,
            },
            { status: 404 }
          ),
  })
}

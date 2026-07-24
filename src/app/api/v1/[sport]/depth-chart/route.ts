// src/app/api/v1/[sport]/depth-chart/route.ts
// NFL depth charts — who actually starts, which drives snap counts and therefore
// most NFL player-prop pricing. Week-scoped.

import { NextRequest, NextResponse } from 'next/server'
import { currentSeason }             from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { qualifierFor }              from '@/lib/cache-key'

const TTL = 43200  // 12h — depth charts shift through the practice week

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const season = searchParams.get('season') ?? currentSeason(sport)
  const week   = searchParams.get('week')   ?? '1'

  return serveCached({
    req,
    sport,
    dataType:  'depth_charts',
    qualifier: qualifierFor(sport, 'depth-chart', { season, week }),
    ttl:       TTL,
    params:    { season, week },
    preflight: () =>
      sport === 'nfl'
        ? null
        : NextResponse.json(
            { error: 'Depth charts are only published for NFL.', supported: ['nfl'] },
            { status: 404 }
          ),
  })
}

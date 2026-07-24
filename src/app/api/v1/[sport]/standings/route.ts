// src/app/api/v1/[sport]/standings/route.ts
// League standings. Tennis has no table — it returns ATP/WTA rankings instead,
// which serve the same purpose for pricing (relative competitor strength).

import { NextRequest }               from 'next/server'
import { currentSeason }             from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { qualifierFor }              from '@/lib/cache-key'

const TTL = 86400  // 1 day — only moves after a slate completes

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const season = searchParams.get('season') ?? currentSeason(sport)

  const isTennis = sport === 'tennis'

  return serveCached({
    req,
    sport,
    dataType:  isTennis ? 'rankings' : 'standings',
    qualifier: qualifierFor(sport, 'standings', { season }),
    ttl:       TTL,
    params:    { season },
    echo:      { season },
  })
}

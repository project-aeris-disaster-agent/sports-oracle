// src/app/api/v1/[sport]/standings/route.ts
// League standings. Tennis has no table — it returns ATP/WTA rankings instead,
// which serve the same purpose for pricing (relative competitor strength).

import { NextRequest }               from 'next/server'
import { currentSeason }             from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { qualifierFor }              from '@/lib/cache-key'
import { ttlFor }                    from '@/lib/capabilities'

// 1 day — only moves after a slate completes. A fallback, not the value: the
// manifest wins, the same way /leaders already works. Every league table in the
// manifest declares exactly this figure, so nothing changes for them; it exists
// so a sport whose ladder moves per match (Agent Fighter) can say so in the one
// place capabilities are declared rather than being silently cached for a day.
const TTL_FALLBACK = 86400

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
    ttl:       ttlFor(sport, 'standings', TTL_FALLBACK),
    params:    { season },
    echo:      { season },
  })
}

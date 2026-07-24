// src/app/api/v1/[sport]/schedule/route.ts
// Season fixture list. Tennis and MMA are date-scoped rather than season-scoped,
// so the cache key follows whichever qualifier actually drives the request.

import { NextRequest }                    from 'next/server'
import { currentSeason, dateParams }      from '@/lib/upstream'
import { serveCached }                    from '@/lib/serve'
import { qualifierFor, DATE_SCOPED }      from '@/lib/cache-key'

const TTL = 604800  // 1 week — fixture lists are published months ahead

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const season = searchParams.get('season') ?? currentSeason(sport)
  const date   = searchParams.get('date')   ?? new Date().toISOString().split('T')[0]

  const dateScoped = DATE_SCOPED.includes(sport)

  return serveCached({
    req,
    sport,
    dataType:  'schedule',
    qualifier: qualifierFor(sport, 'schedule', { season, date }),
    // Date-scoped feeds turn over daily, so don't hold them for a week.
    ttl:       dateScoped ? 3600 : TTL,
    params:    { ...dateParams(date), season },
    echo:      dateScoped ? { date } : { season },
  })
}

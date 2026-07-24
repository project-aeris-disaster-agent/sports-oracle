// src/app/api/v1/[sport]/scores/route.ts
// Results for a given date. Final scores are immutable once posted, so the 1h TTL
// exists only to pick up games that finish during the window.

import { NextRequest, NextResponse } from 'next/server'
import { currentSeason, dateParams } from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { ttlFor }                    from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'

// Per-sport score TTLs live in the capability manifest now — they were declared
// in both places and had drifted (tennis 3h and MMA 6h were only ever honoured
// here, while capabilities.ts advertised 1h for both).
const TTL_FALLBACK = 3600

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const date      = searchParams.get('date')   ?? new Date().toISOString().split('T')[0]
  const season    = searchParams.get('season') ?? currentSeason(sport)
  const fixtureId = searchParams.get('fixture_id') ?? undefined

  return serveCached({
    req,
    sport,
    dataType:  'scores',
    qualifier: qualifierFor(sport, 'scores', { date, season, fixture_id: fixtureId }),
    ttl:       ttlFor(sport, 'scores', TTL_FALLBACK),
    params:    { ...dateParams(date), season },
    echo:      fixtureId ? { fixture_id: fixtureId } : { date },
    preflight: () => {
      // Fixture-keyed sports address a single match, not a day's slate.
      if (sport === 'soccer') {
        return fixtureId
          ? null
          : NextResponse.json(
              { error: 'fixture_id is required for soccer. Get one from /api/v1/soccer/events.' },
              { status: 400 }
            )
      }
      return /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? null
        : NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 })
    },
  })
}

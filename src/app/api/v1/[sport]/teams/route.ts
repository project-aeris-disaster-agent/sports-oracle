// src/app/api/v1/[sport]/teams/route.ts
// League hierarchy — the team/conference/division reference every other lookup
// needs. This is where callers get the team_id required by /roster and /team-stats.

import { NextRequest, NextResponse } from 'next/server'
import { serveCached }               from '@/lib/serve'
import { supportedFor, ttlFor }      from '@/lib/capabilities'

const SUPPORTED = supportedFor('teams')

// Franchise structure changes at most once a season.
const TTL_FALLBACK = 604800

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()

  return serveCached({
    req,
    sport,
    dataType:  'teams',
    qualifier: 'hierarchy',
    ttl:       ttlFor(sport, 'teams', TTL_FALLBACK),
    params:    {},
    preflight: () =>
      SUPPORTED.includes(sport)
        ? null
        : NextResponse.json(
            {
              error: `${sport.toUpperCase()} has no team hierarchy. Tennis and MMA are individual-competitor sports — use /competitions.`,
              supported: SUPPORTED,
            },
            { status: 404 }
          ),
  })
}

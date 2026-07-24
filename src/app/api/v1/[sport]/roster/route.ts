// src/app/api/v1/[sport]/roster/route.ts
// Team roster. Individual-competitor sports (tennis, MMA) have no roster concept
// and say so explicitly rather than returning an empty result.

import { NextRequest, NextResponse } from 'next/server'
import { serveCached }               from '@/lib/serve'
import { qualifierFor }              from '@/lib/cache-key'
import { checkParams }               from '@/lib/params'

const TTL = 604800  // 1 week

const NO_ROSTER: Record<string, string[]> = {
  tennis: ['/api/v1/tennis/standings (ATP/WTA rankings)', '/api/v1/tennis/schedule'],
  mma:    ['/api/v1/mma/schedule (event summaries)'],
}

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)

  // NASCAR keys on race_id (entry list); team sports key on team_id.
  const isNascar = sport === 'nascar'
  const idParam  = isNascar ? 'race_id' : 'team_id'
  const id       = searchParams.get(idParam)

  return serveCached({
    req,
    sport,
    dataType:  isNascar ? 'entries' : 'roster',
    qualifier: qualifierFor(sport, 'roster', { team_id: id ?? undefined, race_id: id ?? undefined }),
    ttl:       TTL,
    params:    id ? { [idParam]: id } : {},
    preflight: () => {
      if (NO_ROSTER[sport]) {
        return NextResponse.json(
          {
            error: `${sport.toUpperCase()} is an individual-competitor sport and has no team rosters.`,
            alternatives: NO_ROSTER[sport],
          },
          { status: 404 }
        )
      }
      if (!id) {
        return NextResponse.json({ error: `${idParam} is required.` }, { status: 400 })
      }
      const badParam = checkParams({ [idParam]: id })
      if (badParam) {
        return NextResponse.json(
          { error: `Invalid "${idParam}" — expected ${badParam.expected}.`, received: badParam.value },
          { status: 400 }
        )
      }
      return null
    },
  })
}

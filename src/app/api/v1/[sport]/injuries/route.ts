// src/app/api/v1/[sport]/injuries/route.ts
// Injury reports — the highest-signal input for line movement and player props.
//
// NBA/NHL/MLB/WNBA expose a league-wide feed. NFL scopes injuries by week, so
// {week} is required there (defaults to 1; pass ?week=N).

import { NextRequest, NextResponse } from 'next/server'
import { currentSeason }             from '@/lib/upstream'
import { serveCached }               from '@/lib/serve'
import { supportedFor }              from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'

// Derived from the capability manifest rather than hardcoded here — a new sport
// declaring an injuries endpoint is reachable immediately, and one that doesn't
// can't be reached by accident.
const SUPPORTED = supportedFor('injuries')

// Adaptive TTL. Injury reports churn in the hours before first pitch/tip and are
// static overnight, so a flat 15-minute TTL spends ~2,880 calls/month per sport to
// re-fetch an unchanged document at 4am. Tightening only during the window that
// matters cuts that by roughly 4x with no loss of freshness when it counts.
//
// Window is 15:00–06:00 UTC, which covers US afternoon through late evening —
// where effectively every NBA/NHL/NFL/MLB/WNBA start time falls.
const TTL_LIVE_WINDOW = 900    // 15 min
const TTL_OFF_HOURS   = 21600  // 6 h

function injuryTtl(now = new Date()): number {
  const h = now.getUTCHours()
  const inWindow = h >= 15 || h < 6
  return inWindow ? TTL_LIVE_WINDOW : TTL_OFF_HOURS
}

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const season = searchParams.get('season') ?? currentSeason(sport)
  const week   = searchParams.get('week')   ?? '1'

  const isNfl     = sport === 'nfl'
  const qualifier = qualifierFor(sport, 'injuries', { season, week })

  return serveCached({
    req,
    sport,
    dataType:  'injuries',
    qualifier,
    ttl:       injuryTtl(),
    params:    { season, week },
    preflight: () =>
      SUPPORTED.includes(sport)
        ? null
        : NextResponse.json(
            {
              error: `Injury data is not available for ${sport.toUpperCase()}.`,
              supported: SUPPORTED,
            },
            { status: 404 }
          ),
  })
}

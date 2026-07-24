// src/app/api/v1/[sport]/live/route.ts
// Live game state. Analyst tier and above.
//
// Live is the single largest consumer of upstream quota: at a 20s TTL an NBA game
// polled end-to-end costs ~450 calls on its own. Two guards keep that in check:
//
//   1. Game-window detection — if the warm schedule cache says nothing is on today,
//      return immediately instead of polling a feed that cannot have data. In the
//      off-season this is the difference between zero spend and continuous spend.
//   2. Short TTL tuned per sport, so concurrent pollers collapse onto one call.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { serveCached }               from '@/lib/serve'
import { TIERS }                     from '@/lib/tiers'
import { getEndpoint, ttlFor }       from '@/lib/capabilities'
import { qualifierFor, FEED_WIDE }   from '@/lib/cache-key'
import { checkParams }              from '@/lib/params'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// TTL now comes from the capability manifest. It used to be declared here AND in
// capabilities.ts, and the two had already drifted.
const TTL_FALLBACK = 30


/**
 * Returns true when the warm cache positively shows no games scheduled today.
 * Returns false if there ARE games, or if we simply don't know — never block a
 * request on missing cache, only on a confirmed-empty slate.
 */
async function noGamesToday(sport: string, today: string): Promise<boolean> {
  const { data } = await supabase.rpc('get_cached', {
    p_cache_key: `${sport}:scores:${today}`,
  })
  if (!data || typeof data !== 'object') return false

  const payload = data as Record<string, unknown>
  const games   = (payload.games ?? (payload.league as Record<string, unknown>)?.games) as unknown[] | undefined

  return Array.isArray(games) && games.length === 0
}

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const sport = params.sport.toLowerCase()
  const { searchParams } = new URL(req.url)
  const gameId   = searchParams.get('game_id')
  const feedWide = FEED_WIDE.includes(sport)
  const today    = new Date().toISOString().split('T')[0]

  if (!feedWide && !gameId) {
    return NextResponse.json({ error: 'game_id is required.' }, { status: 400 })
  }

  // Reject a malformed id here rather than paying a metered upstream call to be
  // told 404 by the provider.
  const badParam = checkParams({ game_id: gameId ?? undefined })
  if (badParam) {
    return NextResponse.json(
      { error: `Invalid "game_id" — expected ${badParam.expected}.`, received: badParam.value },
      { status: 400 }
    )
  }

  // Window guard — cheap Supabase read that can save a whole polling session.
  if (!feedWide && await noGamesToday(sport, today)) {
    return NextResponse.json(
      {
        sport,
        data: null,
        meta: {
          source: 'window-guard',
          reason: `No ${sport.toUpperCase()} games scheduled for ${today}. Upstream not called.`,
          cost:   '0 credits',
        },
      },
      { headers: { 'X-Cache': 'SKIP', 'Cache-Control': 'public, s-maxage=3600', 'Vary': 'X-Oracle-Key' } }
    )
  }

  // The upstream dataType is declared per sport, not assumed. Most sports map
  // /live -> 'live'; F1 maps it to OpenF1's 'position' stream. Reading it from
  // the manifest is what lets a new provider expose /live without a branch here.
  const dataType   = getEndpoint(sport, 'live')?.dataType ?? 'live'
  const sessionKey = searchParams.get('session_key') ?? 'latest'

  return serveCached({
    req,
    sport,
    dataType,
    qualifier: qualifierFor(sport, 'live', { game_id: gameId ?? undefined, session_key: sessionKey }),
    ttl:       ttlFor(sport, 'live', TTL_FALLBACK),
    params:    { game_id: gameId ?? '', session_key: sessionKey },
    echo:      feedWide ? {} : { game_id: gameId! },
    // Sandbox keys pass deliberately — they get synthetic live state, which
    // costs no quota and exposes no licensed data. A free user must be able to
    // rehearse the in-play loop before committing capital to it.
    preflight: (ctx) =>
      (!ctx.sandbox && ctx.tier === 'scout')
        ? NextResponse.json(
            {
              error: `Live data requires Analyst tier. Stake ${TIERS.analyst.stake.toLocaleString()} $DARE to unlock.`,
              sandboxAvailable: true,
            },
            { status: 403 }
          )
        : null,
  })
}

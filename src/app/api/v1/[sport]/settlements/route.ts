// src/app/api/v1/[sport]/settlements/route.ts
// Every settlement transition for a sport since a cursor, in one read.
//
// This is the endpoint a market engine polls instead of polling /resolve per
// market. A busy slate with two hundred open markets was two hundred /resolve
// calls per cycle against a 120 rpm limit; it is now one call that returns only
// what changed since the last one, with a cursor to continue from.
//
// It reads the observation log written by the settlement-watch job, so it costs
// nothing upstream and its latency is a single indexed query. What it returns is
// exactly what the watch job saw, at the moment it saw it, which makes this the
// audit trail as well as the feed: `?revised=true` answers "has an official
// result ever changed" with rows rather than assurances.
//
// Cursor semantics: `since` is an ISO timestamp or a previous `next_since`.
// Rows are ordered by (observed_at, id), and `next_since` is the last row's
// observed_at. A consumer that stores next_since and passes it back never misses
// a transition and never re-reads one, provided it tolerates a duplicate at the
// boundary (same observed_at, which the id column disambiguates on our side).

import { NextRequest, NextResponse } from 'next/server'
import { gateway }                   from '@/middleware/gateway'
import { logRequest }                from '@/lib/serve'
import { isOpenAndFree }             from '@/lib/providers'
import { RESOLVABLE }                from '@/lib/resolution'
import { resolverFor }               from '@/lib/resolve-dispatch'
import { readSettlementFeed }        from '@/lib/settlement-feed'

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const start = Date.now()
  const sport = params.sport.toLowerCase()

  const auth = await gateway(req, sport)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  if (!resolverFor(sport)) {
    return NextResponse.json(
      { error: `Settlement feed is not available for ${sport.toUpperCase()}.`, supported: RESOLVABLE },
      { status: 404 }
    )
  }

  // Same rule as /resolve: settlement data has no synthetic equivalent, so a
  // sandbox key is refused on licensed sources rather than shown real outcomes.
  if (context.sandbox && !isOpenAndFree(sport, 'results')) {
    return NextResponse.json(
      {
        error: 'Settlement data for this sport comes from a licensed source and is not available on a sandbox key.',
        code:  'sandbox_licensed_source',
        sandboxAvailable: RESOLVABLE.filter(s => isOpenAndFree(s, 'results')),
      },
      { status: 403 }
    )
  }

  const qs   = new URL(req.url).searchParams
  const feed = await readSettlementFeed(sport, {
    since:    qs.get('since'),
    revised:  qs.get('revised')  === 'true',
    official: qs.get('official') === 'true',
    limit:    qs.get('limit'),
  })

  if (!feed.ok) {
    const bad = feed.error.startsWith('since must')
    logRequest(context, sport, 'settlements', false, Date.now() - start, bad ? 400 : 500)
    return NextResponse.json({ error: feed.error }, { status: bad ? 400 : 500 })
  }

  logRequest(context, sport, 'settlements', true, Date.now() - start)
  return NextResponse.json(
    feed.body,
    { headers: { 'Cache-Control': 'private, no-store', 'Vary': 'X-Oracle-Key' } }
  )
}

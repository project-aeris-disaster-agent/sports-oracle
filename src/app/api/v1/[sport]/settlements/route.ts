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
import { createClient }              from '@supabase/supabase-js'
import { gateway }                   from '@/middleware/gateway'
import { logRequest }                from '@/lib/serve'
import { isOpenAndFree }             from '@/lib/providers'
import { RESOLVABLE }                from '@/lib/resolution'
import { resolverFor }               from '@/lib/resolve-dispatch'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DEFAULT_LIMIT = 200
const MAX_LIMIT     = 1000
/** Without `since`, how far back the first page reaches. */
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000

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

  const qs      = new URL(req.url).searchParams
  const sinceQ  = qs.get('since')
  const revised = qs.get('revised') === 'true'
  const officialOnly = qs.get('official') === 'true'
  const limit   = Math.min(MAX_LIMIT, Math.max(1, Number(qs.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT))

  let since: string
  if (sinceQ) {
    const t = new Date(sinceQ)
    if (Number.isNaN(t.getTime())) {
      return NextResponse.json({ error: 'since must be an ISO-8601 timestamp or a previous next_since.' }, { status: 400 })
    }
    since = t.toISOString()
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString()
  }

  let q = supabase
    .from('settlement_observations')
    .select('id, event_id, status, official, winner_id, void_reason, prev_status, prev_official, revised, source, resolution, observed_at')
    .eq('sport', sport)
    .gt('observed_at', since)
    .order('observed_at', { ascending: true })
    .order('id',          { ascending: true })
    .limit(limit)
  if (revised)      q = q.eq('revised', true)
  if (officialOnly) q = q.eq('official', true)

  const { data, error } = await q
  if (error) {
    logRequest(context, sport, 'settlements', false, Date.now() - start, 500)
    return NextResponse.json({ error: 'Could not read the settlement feed.' }, { status: 500 })
  }

  const rows = data ?? []
  const last = rows[rows.length - 1]
  logRequest(context, sport, 'settlements', true, Date.now() - start)

  return NextResponse.json(
    {
      sport,
      since,
      count:      rows.length,
      // Pass this back as ?since= to continue. Unchanged when the page is empty,
      // so a quiet slate polls the same cursor rather than drifting forward and
      // skipping a transition that lands between polls.
      next_since: last ? last.observed_at : since,
      has_more:   rows.length === limit,
      transitions: rows.map(r => ({
        observation_id: r.id,
        event_id:       r.event_id,
        observed_at:    r.observed_at,
        from:           r.prev_status ?? null,
        to:             r.status,
        official:       r.official,
        revised:        r.revised,
        winner_id:      r.winner_id,
        void_reason:    r.void_reason,
        // Restated per row so a consumer cannot act on a provisional transition
        // by accident. A revision is never settleable from this feed: it needs
        // a human, and the flag is there to summon one.
        settleable:     r.official && !r.revised,
        resolution:     r.resolution,
      })),
      note: 'Only transitions are listed. An event that has not changed since your cursor is absent, not unresolved.',
    },
    { headers: { 'Cache-Control': 'private, no-store', 'Vary': 'X-Oracle-Key' } }
  )
}

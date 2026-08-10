// src/app/api/v1/[sport]/events/route.ts
// Event registry — the normalised list of things a market can bind to.
//
// Deliberately thin: identity, name, scheduled time, source. A market needs a
// stable id and a start time to open and close on; everything else it needs
// comes from /resolve once the event is over.
//
// Sport-agnostic: what to fetch and how to normalise it lives in
// lib/resolve-dispatch.ts, so a new resolvable sport needs no change here.

import { NextRequest, NextResponse } from 'next/server'
import { gateway }                   from '@/middleware/gateway'
import { logRequest }                from '@/lib/serve'
import { resolveProvider, isOpenAndFree } from '@/lib/providers'
import { RESOLVABLE }                from '@/lib/resolution'
import { resolverFor }               from '@/lib/resolve-dispatch'

const TTL = 3600

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  const start = Date.now()
  const sport = params.sport.toLowerCase()

  const auth = await gateway(req, sport)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  const resolver = resolverFor(sport)
  if (!resolver) {
    return NextResponse.json(
      {
        error: `Event registry is not yet available for ${sport.toUpperCase()}.`,
        supported: RESOLVABLE,
        note: 'Use /schedule for the raw upstream fixture list.',
      },
      { status: 404 }
    )
  }

  // Settlement has no synthetic equivalent — fabricating an outcome would be
  // worse than refusing one — so a sandbox key is refused on licensed sources
  // rather than served real licensed data. This route does not pass through
  // serveCached, so it does not inherit that transport's sandbox short-circuit.
  if (context.sandbox && !isOpenAndFree(sport, 'results')) {
    return NextResponse.json(
      {
        error: 'Settlement data for this sport comes from a licensed source and is not available on a sandbox key.',
        code: 'sandbox_licensed_source',
        sandboxAvailable: RESOLVABLE.filter(s => isOpenAndFree(s, 'results')),
      },
      { status: 403 }
    )
  }

  const qs = new URL(req.url).searchParams

  try {
    const { events: all, fromCache, season } = await resolver.events(sport, {
      season: qs.get('season') ?? undefined,
      from:   qs.get('from')   ?? undefined,
      to:     qs.get('to')     ?? undefined,
    })

    const from = qs.get('from')
    const to   = qs.get('to')
    let events = all
    if (from) events = events.filter(e => !e.scheduled_at || e.scheduled_at >= from)
    if (to)   events = events.filter(e => !e.scheduled_at || e.scheduled_at <= to)

    const provider = resolveProvider(sport, 'schedule')
    logRequest(context, sport, 'events', fromCache, Date.now() - start)

    return NextResponse.json(
      {
        sport,
        season,
        count: events.length,
        events,
        meta: {
          source:      fromCache ? 'cache' : 'origin',
          provider:    provider?.id,
          attribution: provider?.attribution,
        },
      },
      {
        headers: {
          'X-Cache':       fromCache ? 'HIT' : 'MISS',
          'Cache-Control': `public, s-maxage=${TTL}, stale-while-revalidate=${TTL * 2}`,
          'Vary':          'X-Oracle-Key',
        },
      }
    )
  } catch (err) {
    const msg    = err instanceof Error ? err.message : 'Fetch failed'
    const status = (err as { status?: number }).status ?? 502
    logRequest(context, sport, 'events', false, Date.now() - start, status)
    return NextResponse.json({ error: msg }, { status })
  }
}

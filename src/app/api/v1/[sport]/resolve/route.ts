// src/app/api/v1/[sport]/resolve/route.ts
// Market settlement. The whole point of the resolution surface.
//
// Returns a normalised outcome with an explicit `official` flag. A market engine
// settles when — and only when — official is true. Everything else is reported
// honestly as provisional or live so a caller can display it without acting on it.
//
// TTL is two-phase. A pending result is held briefly because it changes; an
// official result is immutable, so it is promoted to a 30-day entry and never
// fetched again.
//
// Sport-agnostic — see lib/resolve-dispatch.ts.

import { NextRequest, NextResponse } from 'next/server'
import { gateway }                   from '@/middleware/gateway'
import { logRequest }                from '@/lib/serve'
import { RESOLVABLE }                from '@/lib/resolution'
import { resolverFor, resolveEvent } from '@/lib/resolve-dispatch'

const TTL_OFFICIAL = 2592000  // 30 days — immutable once official

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
      { error: `Market resolution is not yet available for ${sport.toUpperCase()}.`, supported: RESOLVABLE },
      { status: 404 }
    )
  }

  const eventId = new URL(req.url).searchParams.get('event_id')
  if (!eventId) {
    return NextResponse.json(
      { error: 'event_id is required. Get one from /api/v1/{sport}/events.' },
      { status: 400 }
    )
  }

  try {
    // Per-sport id validation, normalisation and the official-result TTL
    // promotion all live in resolveEvent, so this transport and MCP cannot drift.
    const outcome = await resolveEvent(sport, eventId)

    if (!outcome.ok) {
      const body =
        outcome.reason === 'unsupported'
          ? { error: 'Market resolution is not yet available for this sport.', supported: outcome.supported }
        : outcome.reason === 'malformed'
          ? { error: 'Malformed event_id.', event_id: eventId, expected: outcome.idFormat }
          // Valid id, nothing to settle yet. meta.settleable is explicit so the
          // gate a market reads is present on this path too.
          : { error: 'No result available for this event yet.', event_id: eventId,
              meta: { settleable: false, status: 'unknown' } }

      return NextResponse.json(body, {
        status: outcome.reason === 'malformed' ? 400 : 404,
        headers: { 'X-Settleable': 'false' },
      })
    }

    const { resolution, fromCache } = outcome

    logRequest(context, sport, 'resolve', fromCache, Date.now() - start)

    return NextResponse.json(
      {
        sport,
        event_id: eventId,
        resolution,
        meta: {
          source:     fromCache ? 'cache' : 'origin',
          // Restates the settlement contract on every response so an integrator
          // cannot miss it. Acting on a provisional result is the failure mode
          // this whole surface exists to prevent.
          settleable: resolution.official,
          note: resolution.official
            ? (resolution.void_reason
                ? `Void (${resolution.void_reason}) — no result. Safe to settle as void.`
                : 'Official result. Safe to settle.')
            : `NOT settleable — status is "${resolution.status}".`,
        },
      },
      {
        headers: {
          'X-Cache':      fromCache ? 'HIT' : 'MISS',
          'X-Settleable': String(resolution.official),
          'Cache-Control': `public, s-maxage=${resolution.official ? TTL_OFFICIAL : 60}`,
          'Vary':         'X-Oracle-Key',
        },
      }
    )
  } catch (err) {
    const msg    = err instanceof Error ? err.message : 'Fetch failed'
    const status = (err as { status?: number }).status ?? 502
    logRequest(context, sport, 'resolve', false, Date.now() - start, status)
    return NextResponse.json({ error: msg }, { status })
  }
}

// src/lib/daily-feed.ts
// Shared handler for league-wide feeds addressed by calendar day.
//
// Two endpoints have exactly this shape — /transactions and /changes — and both
// share a property the generic [resource] handler cannot express: the document
// for a CLOSED day is immutable. Once 2026-02-06 is over, neither the moves
// effective that day nor the set of documents that changed that day can change
// again.
//
// A flat TTL therefore has to pick a side. Short, and every request for a past
// date refetches a frozen document — 96 times a day against NBA's 110k/month
// allocation. Long, and today's feed goes stale exactly when it matters. Keying
// the lifetime on "is this day still open" gets both.
//
// This lives here rather than in each route because the two would otherwise be
// copy-pasted, and a TTL table duplicated across files is precisely the drift
// this codebase has been bitten by before (see the note in scores/route.ts).

import { NextRequest, NextResponse } from 'next/server'
import { serveCached }               from '@/lib/serve'
import { currentSeason, dateParams } from '@/lib/upstream'
import { qualifierFor }              from '@/lib/cache-key'
import { getSport, supports, supportedFor } from '@/lib/capabilities'

export interface DailyFeedOptions {
  req:   NextRequest
  sport: string
  /** Manifest path. Doubles as the cache-qualifier key. */
  path:      string
  dataType:  string
  /** Lifetime while the requested day is today or still ahead. */
  ttlOpen:   number
  /** Lifetime once the day has closed and the document is frozen. */
  ttlClosed: number
  /** Noun used in the 404 for sports with no such feed, e.g. 'transaction feed'. */
  absentAs:  string
}

export async function serveDailyFeed(opts: DailyFeedOptions): Promise<NextResponse> {
  const { req, sport, path, dataType, ttlOpen, ttlClosed, absentAs } = opts

  const qs    = new URL(req.url).searchParams
  // UTC, matching every other date-scoped route. The upstream's own day boundary
  // is UTC-based (the feed reports start_time 05:00Z / end_time 04:59Z), so a
  // local-time "today" would ask for a day the upstream has not opened yet.
  const today = new Date().toISOString().split('T')[0]
  const date  = qs.get('date') ?? today

  const spec = getSport(sport)
  if (!spec) {
    return NextResponse.json({ error: `Unknown sport "${sport}".` }, { status: 404 })
  }

  // These routes are static segments, so they shadow the generic [resource]
  // handler for EVERY sport. Sports without the feed must be answered here
  // rather than falling through to a handler that will never see the request.
  if (!supports(sport, path)) {
    return NextResponse.json(
      { error: `${spec.label} has no ${absentAs}.`, supported: supportedFor(path) },
      { status: 404 }
    )
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 })
  }

  return serveCached({
    req,
    sport,
    dataType,
    qualifier: qualifierFor(sport, path, { date }),
    ttl:       date < today ? ttlClosed : ttlOpen,
    params:    { ...dateParams(date), season: qs.get('season') ?? currentSeason(sport) },
    echo:      { date },
  })
}

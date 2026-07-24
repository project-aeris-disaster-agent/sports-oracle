// src/app/api/v1/[sport]/transactions/route.ts
// Roster movement for a calendar day: trades, signings, waivers, assignments.
//
// The adaptive TTL and the date/support guards live in lib/daily-feed.ts, shared
// with /changes — both are league-wide day-scoped feeds whose closed days never
// change again.

import { NextRequest }   from 'next/server'
import { serveDailyFeed } from '@/lib/daily-feed'
import { TTL }            from '@/lib/capabilities'

export async function GET(
  req: NextRequest,
  { params }: { params: { sport: string } }
) {
  return serveDailyFeed({
    req,
    sport:     params.sport.toLowerCase(),
    path:      'transactions',
    dataType:  'transfers',
    ttlOpen:   TTL.txnToday,
    ttlClosed: TTL.txnPast,
    absentAs:  'transaction feed',
  })
}

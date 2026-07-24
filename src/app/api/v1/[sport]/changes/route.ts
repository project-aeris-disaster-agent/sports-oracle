// src/app/api/v1/[sport]/changes/route.ts
// Daily change log — which documents the upstream revised on a given day.
//
// This is the polling endpoint the rest of the API is meant to be driven from.
// Rather than refetching schedules, standings and player profiles on a timer to
// find out whether anything moved, a consumer polls this one 15KB document and
// refetches only the ids it names. Shares lib/daily-feed.ts with /transactions.

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
    path:      'changes',
    dataType:  'changes',
    ttlOpen:   TTL.changesToday,
    ttlClosed: TTL.txnPast,
    absentAs:  'change log',
  })
}

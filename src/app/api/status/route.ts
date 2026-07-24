// src/app/api/status/route.ts
// Public service-status endpoint.
//
// Unauthenticated on purpose: an agent needs to know whether a sport is healthy
// *before* it decides to spend a request on it, and a status check that requires
// a key is useless during a credential problem. It exposes only aggregate service
// state — quota headroom and availability — never sports data itself.

import { NextResponse } from 'next/server'
import { getLiveStatus, summarise } from '@/lib/status'
import { SPORTS } from '@/lib/capabilities'

// Recheck at most once a minute; status does not move faster than that and this
// endpoint should never become a load source of its own.
export const revalidate = 60

export async function GET() {
  const statuses = await getLiveStatus()
  const summary  = summarise(statuses)

  const specByKey = new Map(SPORTS.map(s => [s.key, s]))

  return NextResponse.json(
    {
      service: summary.offline === SPORTS.length ? 'down'
             : summary.limited + summary.offline > 0 ? 'degraded'
             : 'operational',
      checkedAt: new Date().toISOString(),
      // Flags whether these numbers are live or the declared fallback, so a
      // consumer can tell "everything is fine" from "we couldn't check".
      source: summary.live ? 'database' : 'fallback',
      summary: {
        operational: summary.online,
        limited:     summary.limited,
        offline:     summary.offline,
      },
      // Deliberately qualitative. Quota sizes, utilisation and remaining-call
      // counts describe our capacity and cost structure — they belong on the
      // authenticated dashboard, not on a public endpoint. `degraded` tells a
      // caller everything it needs to decide whether to back off.
      sports: statuses.map(s => ({
        sport:     s.key,
        label:     specByKey.get(s.key)?.label ?? s.key,
        status:    s.status,
        note:      s.statusNote,
        available: s.entitled,
        endpoints: specByKey.get(s.key)?.endpoints.length ?? 0,
        realtime:  s.entitled && !s.cacheOnly,
        // Provenance is public by design. Naming the upstream is both an
        // attribution obligation to the open providers we depend on and the
        // thing that lets a consumer judge the data before they integrate.
        sources: (specByKey.get(s.key)?.sources ?? []).map(src => ({
          id:            src.id,
          label:         src.label,
          homepage:      src.homepage,
          license:       src.license,
          status:        src.status,
          isDefault:     src.isDefault,
          authoritative: src.authoritative,
        })),
      })),
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    }
  )
}

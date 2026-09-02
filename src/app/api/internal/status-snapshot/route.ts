// src/app/api/internal/status-snapshot/route.ts
// Records one row of service status. Driven by pg_cron every five minutes.
//
// This is the measurement behind any availability figure we ever publish. The
// landing page used to say "99.9% uptime" with nothing behind it; it now says
// nothing, and will say a number again only when this table can support one.
//
// It reuses getLiveStatus() rather than re-deriving anything, so the history is
// exactly what /api/status showed at that moment, not a parallel opinion.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { guardInternal }             from '@/middleware/gateway'
import { getLiveStatus, summarise }  from '@/lib/status'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  if (!guardInternal(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const statuses = await getLiveStatus()
  const summary  = summarise(statuses)

  // A snapshot taken while the database was unreachable is the fallback table,
  // not an observation. Recording it would count an outage of the status page
  // itself as a healthy service.
  if (!summary.live) {
    return NextResponse.json({ recorded: false, reason: 'status source was fallback, not database' })
  }

  const service = summary.serving === 0 || summary.offline === summary.serving ? 'down'
                : summary.belowDeclared > 0 ? 'degraded'
                : 'operational'

  const { error } = await supabase.from('status_history').insert({
    service,
    operational: summary.online,
    limited:     summary.limited,
    offline:     summary.offline,
    sports:      statuses
      .filter(s => s.entitled)
      .map(s => ({ sport: s.key, status: s.status, note: s.statusNote })),
  })

  if (error) {
    console.error('[status-snapshot]', error.message)
    return NextResponse.json({ recorded: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ recorded: true, service, ...summary })
}

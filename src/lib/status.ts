// src/lib/status.ts
// Live per-sport service status, derived from the database rather than declared.
//
// capabilities.ts carries the *shape* of each sport (which endpoints exist, what
// they cost, who can reach them). That is static and safe to hardcode. Service
// *state* is not: quota fills, entitlements change, a sport flips to cache-only
// at 90% usage. Hardcoding that guarantees the site eventually lies.
//
// This module reads the real numbers and falls back to the declared values only
// if the database is unreachable — a status page that breaks when the backend
// breaks is worse than useless.

import { createClient } from '@supabase/supabase-js'
import { SPORTS, STATUS_RANK, type SportStatus, type SportSpec } from '@/lib/capabilities'

export interface LiveSportStatus {
  key:        string
  status:     SportStatus
  statusNote: string
  entitled:   boolean
  callsMade:  number
  callsLimit: number
  pctUsed:    number
  remaining:  number
  cacheOnly:  boolean
  lastCallAt: string | null
  /** True when these numbers came from the database rather than the fallback. */
  live:       boolean
}

// A sport with very little monthly headroom is reported as limited even at 0%
// usage — callers should know to poll it conservatively before they exhaust it.
const LOW_HEADROOM = 5000

function derive(
  spec: SportSpec,
  row: { calls_made: number; calls_limit: number; cache_only: boolean; entitled: boolean | null; last_call_at: string | null }
): LiveSportStatus {
  const callsMade  = row.calls_made ?? 0
  const callsLimit = row.calls_limit ?? 0
  const remaining  = Math.max(0, callsLimit - callsMade)
  const pctUsed    = callsLimit > 0 ? +(callsMade / callsLimit * 100).toFixed(2) : 0
  const entitled   = row.entitled ?? spec.entitled

  let status: SportStatus
  let statusNote: string

  // NOTE: statusNote is rendered on the public site. It must stay qualitative —
  // never quota sizes, utilisation percentages or remaining-call counts. Those
  // reveal capacity and cost structure to competitors. The numeric fields below
  // are returned for operator-facing surfaces (dashboard) only.
  if (!entitled) {
    status = 'offline'
    statusNote = 'Not currently available'
  } else if (row.cache_only) {
    status = 'limited'
    statusNote = 'Serving recent data — real-time temporarily paused'
  } else if (pctUsed >= 80) {
    status = 'limited'
    statusNote = 'High demand — real-time may be throttled'
  } else if (callsLimit > 0 && callsLimit <= LOW_HEADROOM) {
    status = 'limited'
    statusNote = 'Event-based coverage'
  } else {
    status = 'online'
    statusNote = 'All endpoints operational'
  }

  // The declared status is a CEILING. This function measures budget health and
  // nothing else, so it may degrade a sport but must never promote one.
  //
  // Without this clamp, any entitled sport on an unmetered provider reports
  // "All endpoints operational" for free: callsLimit is 0, so every quota branch
  // above is skipped and it lands in the else. That is a statement about spend,
  // not about whether the upstream answers — and it was overriding sports that
  // capabilities.ts deliberately marks `limited` because their integration is
  // unverified, advertising them as fully operational on the public page.
  if (STATUS_RANK[status] < STATUS_RANK[spec.status]) {
    status     = spec.status
    statusNote = spec.statusNote
  }

  return { key: spec.key, status, statusNote, entitled, callsMade, callsLimit, pctUsed, remaining,
           cacheOnly: !!row.cache_only, lastCallAt: row.last_call_at, live: true }
}

/** Declared values from capabilities.ts, used when the database can't be reached. */
function fallback(spec: SportSpec): LiveSportStatus {
  return {
    key: spec.key, status: spec.status, statusNote: spec.statusNote, entitled: spec.entitled,
    callsMade: 0, callsLimit: 0, pctUsed: 0, remaining: 0, cacheOnly: false,
    lastCallAt: null, live: false,
  }
}

export async function getLiveStatus(): Promise<LiveSportStatus[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return SPORTS.map(fallback)

  try {
    const supabase = createClient(url, key)
    const { data, error } = await supabase.from('budget_status').select('*')
    if (error || !data) return SPORTS.map(fallback)

    const byKey = new Map(data.map(r => [r.sport, r]))
    return SPORTS.map(spec => {
      const row = byKey.get(spec.key)
      return row ? derive(spec, row) : fallback(spec)
    })
  } catch {
    // Never let a status lookup take the page down.
    return SPORTS.map(fallback)
  }
}

export function summarise(list: LiveSportStatus[]) {
  return {
    online:  list.filter(s => s.status === 'online').length,
    limited: list.filter(s => s.status === 'limited').length,
    offline: list.filter(s => s.status === 'offline').length,
    live:    list.some(s => s.live),
  }
}

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

interface HealthRow {
  sport: string; calls: number; failures: number
  last_ok_at: string | null; last_fail_at: string | null
  last_status: number | null; last_error: string | null
}

interface SubscriptionRow {
  provider: string; expires_at: string | null
}

/** Days of warning before a provider subscription lapses. */
const SUBSCRIPTION_WARN_DAYS = 3

/**
 * Upstream health and subscription state, applied on top of the budget-derived
 * status. Both can only LOWER a status, never raise it, so a sport declared
 * `limited` for an unrelated reason stays at least that.
 *
 * Why this exists: status was previously a function of quota and entitlement
 * only. TxLINE is unmetered and always entitled, so when its API token expired
 * on 2026-08-18 every soccer call returned 403 for two weeks while this module
 * reported "All endpoints operational" the entire time. A customer found it.
 */
function applyUpstreamState(
  status: SportStatus, statusNote: string,
  health: HealthRow | undefined, sub: SubscriptionRow | undefined
): { status: SportStatus; statusNote: string } {
  const lower = (to: SportStatus, note: string) =>
    STATUS_RANK[to] < STATUS_RANK[status] ? { status: to, statusNote: note } : { status, statusNote }

  // Subscription lapse is knowable in advance; say so before it happens.
  if (sub?.expires_at) {
    const msLeft = new Date(sub.expires_at).getTime() - Date.now()
    if (msLeft <= 0) return lower('offline', 'Upstream subscription expired — renewal required')
    if (msLeft < SUBSCRIPTION_WARN_DAYS * 86400000) {
      const r = lower('limited', `Upstream subscription expires in ${Math.ceil(msLeft / 86400000)}d`)
      status = r.status; statusNote = r.statusNote
    }
  }

  if (!health || health.calls === 0 || health.failures === 0) return { status, statusNote }

  const allFailing = health.last_ok_at === null && health.calls >= 2
  if (allFailing) {
    // 401/403 is an operator problem (credentials, entitlement), not a blip.
    // Naming it as such is the difference between "retry later" and "act now".
    const auth = health.last_status === 401 || health.last_status === 403
    return lower('offline', auth
      ? 'Upstream rejected our credentials — real-time data unavailable'
      : 'Upstream not responding — serving cached data only')
  }
  return lower('limited', 'Intermittent upstream errors — recent data may be delayed')
}

function derive(
  spec: SportSpec,
  row: { calls_made: number; calls_limit: number; cache_only: boolean; entitled: boolean | null; last_call_at: string | null },
  health?: HealthRow,
  sub?: SubscriptionRow
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

  // Applied AFTER the ceiling clamp on purpose: the clamp stops budget health
  // from promoting a sport, whereas upstream failure must be allowed to demote
  // one below its declared status. An 'online' declaration is a statement about
  // integration completeness, not a promise that the upstream is up right now.
  if (entitled) {
    const adjusted = applyUpstreamState(status, statusNote, health, sub)
    status     = adjusted.status
    statusNote = adjusted.statusNote
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
    const [budget, health, subs, proj] = await Promise.all([
      supabase.from('budget_status').select('*'),
      supabase.rpc('upstream_health_summary', { p_minutes: 30 }),
      supabase.from('provider_subscriptions').select('provider, expires_at'),
      supabase.from('quota_projection').select('sport, projected_pct, day_of_month'),
    ])
    if (budget.error || !budget.data) return SPORTS.map(fallback)

    const byKey     = new Map(budget.data.map(r => [r.sport, r]))
    const healthBy  = new Map<string, HealthRow>(((health.data ?? []) as HealthRow[]).map(h => [h.sport, h]))
    const subBy     = new Map<string, SubscriptionRow>(((subs.data ?? []) as SubscriptionRow[]).map(x => [x.provider, x]))

    // An unmetered sport has no budget row. It used to fall back to its declared
    // status, which is how soccer stayed "online" through a two-week outage —
    // there was no path by which it could be degraded. A zero row lets it go
    // through the same health checks as everything else.
    const ZERO = { calls_made: 0, calls_limit: 0, cache_only: false, entitled: null, last_call_at: null }

    const projBy = new Map<string, number>(
      ((proj.data ?? []) as { sport: string; projected_pct: number | null; day_of_month: number }[])
        // A projection from the first two days of a month is noise, not a trend.
        .filter(p => p.day_of_month >= 3 && p.projected_pct != null)
        .map(p => [p.sport, Number(p.projected_pct)])
    )

    return SPORTS.map(spec => {
      const row       = byKey.get(spec.key) ?? ZERO
      const defaultId = spec.sources.find(s => s.isDefault)?.id
      const derived   = derive(spec, row, healthBy.get(spec.key), defaultId ? subBy.get(defaultId) : undefined)
      // On pace to exhaust the month: degrade now, while there is still a month
      // left to do something about it. Qualitative in the note, as always.
      const projected = projBy.get(spec.key)
      if (derived.entitled && projected !== undefined && projected >= 100 && derived.status === 'online') {
        return { ...derived, status: 'limited', statusNote: 'High demand — real-time may be throttled later this month' }
      }
      return derived
    })
  } catch {
    // Never let a status lookup take the page down.
    return SPORTS.map(fallback)
  }
}

/**
 * Aggregate health.
 *
 * The counts are over ENTITLED sports only, and that distinction is the whole
 * point of this function.
 *
 * The registry deliberately carries sports we do not serve — 16 of them, mostly
 * esports titles whose publishers do not license redistribution. providers/types.ts
 * argues at length that publishing an unreachable source as `offline` is better
 * than pretending it does not exist, and that argument stands. But those entries
 * were also being counted here, so `offline` was never zero, and the service
 * verdict derived from it reported "degraded" permanently, in every response,
 * regardless of whether anything was actually wrong.
 *
 * A health signal that never says "healthy" carries no information. A customer
 * polling /api/status to decide whether to back off learned nothing from it, and
 * a real outage looked identical to a normal Tuesday. So the verdict is scoped to
 * the sports we actually undertake to serve; `registered` reports the rest
 * separately, because it is inventory, not health.
 */
export function summarise(list: LiveSportStatus[]) {
  const serving = list.filter(s => s.entitled)
  return {
    online:  serving.filter(s => s.status === 'online').length,
    limited: serving.filter(s => s.status === 'limited').length,
    offline: serving.filter(s => s.status === 'offline').length,
    /** Total entitled sports, i.e. the denominator the counts above are out of. */
    serving: serving.length,
    /** Registered but not entitled. Inventory we publish, not a fault. */
    registered: list.length - serving.length,
    live:    list.some(s => s.live),
  }
}

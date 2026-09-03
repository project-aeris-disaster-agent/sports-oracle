// src/app/api/internal/settlement-watch/route.ts
// Watches settleable events for state changes, records every transition, and
// pushes webhooks for the ones a market cares about. Driven by pg_cron every
// five minutes, one POST per entitled sport, exactly like cache-warm.
//
// ─── What this answers ───────────────────────────────────────────────────────
// Three questions a prediction-market customer asked that the system could not
// answer before:
//
//   "Has an official result ever been revised?"  Nothing looked twice: once a
//   result was official it was cached for 30 days and never re-read. Now every
//   recently-official event is re-resolved inside a per-sport revision window,
//   and a change after official is recorded with revised = true. If the answer
//   stays "never", it is now backed by a log rather than a shrug.
//
//   "Webhook or polling?"  Polling only. Now a subscriber is POSTed the moment
//   an event goes official, void, or (worst case) revised. No persistent
//   process is involved; the cron is the clock.
//
//   "What is provisional-to-official latency?"  The observation log carries
//   the timestamp of every transition, so it can be measured per sport instead
//   of quoted from a policy constant.
//
// ─── Bounded by construction ─────────────────────────────────────────────────
// Vercel gives a function ten seconds on the hobby plan. Every loop below is
// capped, and a wall-clock budget is checked between steps, so a run that has
// too much to do stops cleanly and the next one (five minutes later) continues.
// Nothing is lost by stopping early: the watchlist is a database query, not
// in-memory state.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import crypto                        from 'crypto'
import { guardInternal }             from '@/middleware/gateway'
import { resolverFor, resolveEvent } from '@/lib/resolve-dispatch'
import type { Resolution }           from '@/lib/resolution'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Wall-clock budget for one run. Leaves headroom under the 10s function limit. */
const TIME_BUDGET_MS = 8_000
/** New, never-observed events resolved per run. */
const MAX_NEW        = 10
/** Watchlist re-checks per run. */
const MAX_WATCH      = 15
/** Webhook deliveries (new + retried) per run. */
const MAX_DELIVER    = 15
const MAX_ATTEMPTS   = 5
const WEBHOOK_TIMEOUT_MS = 4_000

/**
 * How long after an event goes official we keep re-checking it.
 *
 * F1 is the outlier for a documented reason: the FIA can revise a classification
 * through appeals and post-race penalties days later, and that is the single
 * largest revision exposure in the build. Everything else settles within hours
 * of the final whistle and a three-day window is generous.
 */
const REVISION_DAYS: Record<string, number> = { f1: 30 }
const DEFAULT_REVISION_DAYS = 3

/** How far back to look for events that ended but have never been observed. */
const NEW_EVENT_LOOKBACK_MS = 36 * 3600 * 1000

/** Which observation transitions produce a webhook, and the event name sent. */
function webhookEvent(r: Resolution, revised: boolean): string | null {
  if (revised)                    return 'settlement.revised'
  if (r.status === 'void')        return 'settlement.void'
  if (r.official)                 return 'settlement.official'
  // Opt-in only: a subscription has to list `provisional` to receive these.
  // /api/auth/webhooks has offered that option since it shipped, but this
  // function never emitted it, so opting in did nothing. A market that wants
  // to freeze trading the moment an outcome is known, before it is official,
  // is exactly who asks for it.
  if (r.status === 'provisional') return 'settlement.provisional'
  return null  // scheduled/live transitions are logged, not pushed
}

/** Stable digest of the parts of a resolution that constitute the outcome. */
function contentHash(r: Resolution): string {
  const material = {
    status: r.status, official: r.official, winner_id: r.winner_id, void_reason: r.void_reason,
    competitors: r.competitors.map(c => [c.competitor_id, c.position, c.points, c.finished]),
  }
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32)
}

interface Subscription { id: string; url: string; secret: string; sports: string[]; events: string[] }

export async function POST(req: NextRequest) {
  if (!guardInternal(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body  = await req.json().catch(() => ({}))
  const sport = String(body.sport ?? '').toLowerCase()
  if (!sport) return NextResponse.json({ error: 'sport required' }, { status: 400 })

  // The cron posts every entitled sport. One without a resolver is not an
  // error, it is simply not settleable yet.
  const resolver = resolverFor(sport)
  if (!resolver) return NextResponse.json({ sport, skipped: 'no resolver' })

  const started  = Date.now()
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started)
  const report = { sport, retried: 0, watched: 0, discovered: 0, transitions: 0, revisions: 0, delivered: 0, failed: 0, stoppedEarly: false }

  const { data: subsRaw } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, secret, sports, events')
    .eq('is_active', true)
  const subs = ((subsRaw ?? []) as Subscription[])
    .filter(s => s.sports.length === 0 || s.sports.includes(sport))

  // ── 1. Retry failed deliveries first: a subscriber's outage must not lose a
  //       settlement notification. ───────────────────────────────────────────
  if (subs.length) {
    const { data: queue } = await supabase.rpc('webhook_retry_queue', { p_max_attempts: MAX_ATTEMPTS, p_limit: MAX_DELIVER })
    for (const item of (queue ?? []) as { subscription_id: string; observation_id: number; attempts: number }[]) {
      if (timeLeft() < 1500) { report.stoppedEarly = true; break }
      const sub = subs.find(s => s.id === item.subscription_id)
      if (!sub) continue
      const { data: obs } = await supabase
        .from('settlement_observations')
        .select('id, sport, event_id, status, official, revised, resolution, observed_at')
        .eq('id', item.observation_id).maybeSingle()
      if (!obs || obs.sport !== sport) continue
      const ok = await deliver(sub, obs, item.attempts + 1)
      report.retried++
      ok ? report.delivered++ : report.failed++
    }
  }

  // ── 2. Re-check the watchlist: pending events, and official ones still inside
  //       the revision window. ─────────────────────────────────────────────────
  const revisionDays = REVISION_DAYS[sport] ?? DEFAULT_REVISION_DAYS
  const { data: watch } = await supabase.rpc('settlement_watchlist', {
    p_sport: sport, p_revision_days: revisionDays, p_limit: MAX_WATCH,
  })
  const seen = new Set<string>()
  for (const w of (watch ?? []) as { event_id: string }[]) {
    if (timeLeft() < 2000) { report.stoppedEarly = true; break }
    seen.add(w.event_id)
    await observe(w.event_id)
    report.watched++
  }

  // ── 3. Discover events that recently ended and have never been observed. ──
  if (!report.stoppedEarly && timeLeft() > 2500) {
    try {
      // Two registry reads, merged. A season schedule answers both identically
      // (the second is a cache hit), but the windowed registries do not: TxLINE
      // returns fixtures starting AT OR AFTER the anchor day, and the tennis and
      // MMA documents are one calendar day each. Anchored on "now" alone, none of
      // them can contain a fixture that finished yesterday, so discovery for
      // those sports found nothing, permanently, on its very first production
      // run. Anchoring a second read at the lookback boundary is what makes
      // recently-finished events visible.
      const now  = Date.now()
      const from = new Date(now - NEW_EVENT_LOOKBACK_MS).toISOString()
      const [current, earlier] = await Promise.all([
        resolver.events(sport, {}),
        resolver.events(sport, { from }).catch(() => ({ events: [] })),
      ])
      const merged = new Map<string, (typeof current.events)[number]>()
      for (const e of [...earlier.events, ...current.events]) merged.set(e.event_id, e)
      const events = [...merged.values()]
      const candidates = events
        .filter(e => e.scheduled_at)
        .filter(e => {
          const t = new Date(e.scheduled_at!).getTime()
          return t <= now && now - t <= NEW_EVENT_LOOKBACK_MS
        })
        .filter(e => !seen.has(e.event_id))
        .sort((a, b) => a.scheduled_at!.localeCompare(b.scheduled_at!))

      // Only those with no observation row at all. One query, not one per event.
      const ids = candidates.map(e => e.event_id)
      const { data: known } = ids.length
        ? await supabase.from('settlement_observations').select('event_id').eq('sport', sport).in('event_id', ids)
        : { data: [] }
      const knownSet = new Set(((known ?? []) as { event_id: string }[]).map(k => k.event_id))

      for (const e of candidates.filter(c => !knownSet.has(c.event_id)).slice(0, MAX_NEW)) {
        if (timeLeft() < 2000) { report.stoppedEarly = true; break }
        await observe(e.event_id)
        report.discovered++
      }
    } catch (err) {
      console.error(`[settlement-watch] ${sport} discovery failed:`, (err as Error).message)
    }
  }

  return NextResponse.json({ ...report, ms: Date.now() - started })

  // ── helpers ────────────────────────────────────────────────────────────────

  async function observe(eventId: string): Promise<void> {
    let outcome
    try {
      outcome = await resolveEvent(sport, eventId)
    } catch (err) {
      console.error(`[settlement-watch] ${sport}/${eventId}:`, (err as Error).message)
      return
    }
    if (!outcome.ok) return  // not found / malformed: nothing to observe

    const r = outcome.resolution
    const { data: obsId, error } = await supabase.rpc('record_settlement_observation', {
      p_sport: sport, p_event_id: eventId, p_status: r.status, p_official: r.official,
      p_winner_id: r.winner_id, p_void_reason: r.void_reason, p_content_hash: contentHash(r),
      p_source: r.source, p_resolution: r,
    })
    if (error) { console.error('[settlement-watch] record failed:', error.message); return }
    if (obsId == null) return  // heartbeat, no change

    report.transitions++
    const { data: row } = await supabase
      .from('settlement_observations').select('revised, observed_at').eq('id', obsId).single()
    const revised = Boolean(row?.revised)
    if (revised) report.revisions++

    const eventName = webhookEvent(r, revised)
    if (!eventName || !subs.length) return

    const targets = subs.filter(s => s.events.includes(eventName.split('.')[1]))
    for (let i = 0; i < targets.length; i++) {
      const sub = targets[i]
      if (report.delivered + report.failed >= MAX_DELIVER || timeLeft() < 1500) {
        // Out of budget with deliveries still owed. Record each as a deferred
        // attempt 0 so the retry queue owns them from here: without a row the
        // queue has nothing to retry, and the notification is silently lost.
        // That happened in production on the first Dota 2 official flip.
        report.stoppedEarly = true
        await supabase.from('webhook_deliveries').insert(
          targets.slice(i).map(t => ({ subscription_id: t.id, observation_id: obsId as number, attempt: 0, status: null, error: 'deferred: run time budget exhausted' }))
        )
        return
      }
      const ok = await deliver(sub, {
        id: obsId as number, sport, event_id: eventId, status: r.status, official: r.official,
        revised, resolution: r, observed_at: row?.observed_at ?? new Date().toISOString(),
      }, 1)
      ok ? report.delivered++ : report.failed++
    }
  }

  async function deliver(
    sub: Subscription,
    obs: { id: number; sport: string; event_id: string; status: string; official: boolean; revised: boolean; resolution: unknown; observed_at: string },
    attempt: number
  ): Promise<boolean> {
    const eventName = obs.revised ? 'settlement.revised' : obs.status === 'void' ? 'settlement.void' : obs.official ? 'settlement.official' : obs.status === 'provisional' ? 'settlement.provisional' : 'settlement.update'
    const payload = JSON.stringify({
      event:          eventName,
      observation_id: obs.id,
      sport:          obs.sport,
      event_id:       obs.event_id,
      observed_at:    obs.observed_at,
      attempt,
      resolution:     obs.resolution,
      meta: { settleable: obs.official && !obs.revised, revised: obs.revised },
    })
    // HMAC over the exact body, so a receiver can verify both origin and
    // integrity with one shared secret. Standard `sha256=<hex>` framing.
    const signature = 'sha256=' + crypto.createHmac('sha256', sub.secret).update(payload).digest('hex')

    let status: number | null = null
    let error:  string | null = null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type':       'application/json',
          'User-Agent':         'sports-oracle-webhook/1',
          'X-Oracle-Event':     eventName,
          'X-Oracle-Signature': signature,
          'X-Oracle-Delivery':  `${obs.id}:${attempt}`,
        },
        body: payload,
        signal: controller.signal,
      })
      status = res.status
      if (!res.ok) error = (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`
    } catch (err) {
      error = (err as Error).name === 'AbortError' ? `timeout after ${WEBHOOK_TIMEOUT_MS}ms` : (err as Error).message
    } finally {
      clearTimeout(timer)
    }

    const ok = status !== null && status >= 200 && status < 300
    await supabase.from('webhook_deliveries').insert({
      subscription_id: sub.id, observation_id: obs.id, attempt, status, error,
    })
    await supabase.from('webhook_subscriptions').update(
      ok ? { last_success_at: new Date().toISOString(), failures: 0 }
         : { last_failure_at: new Date().toISOString() }
    ).eq('id', sub.id)
    if (!ok) {
      // Increment separately; PostgREST has no atomic += without an RPC.
      await supabase.rpc('increment_webhook_failures', { p_id: sub.id }).then(() => {}, () => {})
    }
    return ok
  }
}

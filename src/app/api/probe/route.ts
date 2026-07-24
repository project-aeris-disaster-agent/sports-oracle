// src/app/api/probe/route.ts
// Endpoint liveness check, powering the "Test" button on the sport cards.
//
// SIGN-IN REQUIRED. This calls real upstreams, and some of those cost money per
// request, so it is not something an anonymous visitor gets to trigger. A Privy
// session ties every probe to an account that can be rate limited and, if abused,
// suspended — an IP cannot.
//
// Three further constraints, each load-bearing:
//
//   1. IT RETURNS NO DATA. Only status, latency and provenance. Echoing payloads
//      here would be a bypass of the entire licence and staking gate — a signed-in
//      free account could read licensed Sportradar data without a key.
//   2. IT MUST NOT BURN QUOTA. Results are memoised per (sport, endpoint) and a
//      cache hit is reported without touching the upstream. Otherwise the button
//      is a free way to drain a metered allocation — MMA's is 2,500 a month.
//   3. IT IS RATE LIMITED PER ACCOUNT, with a per-IP limit underneath it so that
//      minting accounts is not a way around the first limit.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { Ratelimit }                 from '@upstash/ratelimit'
import { Redis }                     from '@upstash/redis'
import { getSport, getEndpoint }     from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'
import { resolve }                   from '@/lib/providers'
import { authenticate }              from '@/lib/privy'
import { fetchUpstream, currentSeason, dateParams } from '@/lib/upstream'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// Per account: generous enough to walk every endpoint on a card ("Test all" on
// the largest sport is 9 probes) a few times over, without allowing a loop.
const accountLimiter = new Ratelimit({
  redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'rl:probe:acct',
})

// Per IP, sitting underneath the account limit. Privy accounts are cheap to
// create, so an account-only limit would be trivially defeated by making more.
const ipLimiter = new Ratelimit({
  redis, limiter: Ratelimit.slidingWindow(60, '5 m'), prefix: 'rl:probe:ip',
})

// A daily ceiling per account. The per-minute window stops bursts; this stops a
// patient caller from spending all day slowly draining a metered upstream.
const dailyLimiter = new Ratelimit({
  redis, limiter: Ratelimit.slidingWindow(300, '24 h'), prefix: 'rl:probe:day',
})

/**
 * Memoised probe results. A cold probe may cost one upstream call; every repeat
 * within the window is free, so a user hammering the button cannot spend quota.
 */
const RESULT_TTL_MS = 60_000
const memo = new Map<string, { at: number; body: ProbeResult }>()

type ProbeState = 'live' | 'cached' | 'offline' | 'unavailable' | 'needs-params' | 'error'

interface ProbeResult {
  sport:      string
  endpoint:   string
  state:      ProbeState
  ok:         boolean
  status:     number | null
  latencyMs:  number | null
  source:     'cache' | 'origin' | null
  provider:   string | null
  detail:     string
  checkedAt:  string
}

export async function GET(req: NextRequest) {
  // 1. Sign-in gate. Checked before anything else so an anonymous caller learns
  //    nothing about which endpoints exist or how they behave.
  const accountId = await authenticate(req)
  if (!accountId) {
    return NextResponse.json(
      { error: 'Sign in to test endpoints.', authRequired: true },
      { status: 401 }
    )
  }

  const qs       = new URL(req.url).searchParams
  const sport    = (qs.get('sport') ?? '').toLowerCase()
  const endpoint = (qs.get('endpoint') ?? '').toLowerCase()

  const spec = getSport(sport)
  const ep   = spec && getEndpoint(sport, endpoint)
  if (!spec || !ep) {
    return NextResponse.json({ error: 'Unknown sport or endpoint.' }, { status: 404 })
  }

  // 2. Memoised result. Served before the rate limiters so that re-testing an
  //    endpoint someone just tested is free and does not consume their budget.
  const memoKey = `${sport}:${endpoint}`
  const hit = memo.get(memoKey)
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) {
    return NextResponse.json(hit.body, { headers: { 'X-Probe-Cache': 'HIT' } })
  }

  // 3. Rate limits. Only reached when the probe will do real work.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const [acct, perIp, daily] = await Promise.all([
    accountLimiter.limit(accountId),
    ipLimiter.limit(ip),
    dailyLimiter.limit(accountId),
  ])

  const blocked =
    !acct.success  ? { scope: 'account', reset: acct.reset,  msg: 'Too many endpoint tests. Try again in a minute.' } :
    !perIp.success ? { scope: 'ip',      reset: perIp.reset, msg: 'Too many endpoint tests from this network.' } :
    !daily.success ? { scope: 'daily',   reset: daily.reset, msg: 'Daily endpoint-test limit reached.' } :
    null

  if (blocked) {
    return NextResponse.json(
      { error: blocked.msg, scope: blocked.scope, reset: new Date(blocked.reset).toISOString() },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.max(1, Math.ceil((blocked.reset - Date.now()) / 1000))),
          'X-RateLimit-Scope': `probe:${blocked.scope}`,
        },
      }
    )
  }

  const base = {
    sport, endpoint,
    checkedAt: new Date().toISOString(),
    latencyMs: null as number | null,
    status: null as number | null,
    source: null as 'cache' | 'origin' | null,
  }

  const finish = (r: ProbeResult) => {
    memo.set(memoKey, { at: Date.now(), body: r })
    return NextResponse.json(r, {
      headers: { 'X-Probe-Cache': 'MISS', 'Cache-Control': 'public, s-maxage=60' },
    })
  }

  const picked = resolve(sport, ep.dataType)

  if (!picked.ok) {
    return finish({
      ...base, provider: picked.provider?.id ?? null, ok: false,
      state:  picked.reason === 'offline' ? 'offline' : 'unavailable',
      detail: picked.reason === 'offline'
        ? picked.provider?.offlineReason ?? 'Source registered but not serving.'
        : 'No provider is configured for this endpoint.',
    })
  }

  const provider = picked.provider

  if (!spec.entitled) {
    return finish({
      ...base, provider: provider.id, ok: false, state: 'unavailable',
      detail: spec.note ?? 'Not available on the current plan.',
    })
  }

  // Endpoints keyed on a caller-supplied id cannot be probed blind — there is no
  // correct id to invent. Saying so is more useful than a fabricated green tick.
  const required = ep.params.filter(p => !p.endsWith('?'))
  if (required.length) {
    return finish({
      ...base, provider: provider.id, ok: false, state: 'needs-params',
      detail: `Requires ${required.join(', ')} — supply one via the API to test this endpoint.`,
    })
  }

  const season = currentSeason(sport)
  const date   = new Date().toISOString().split('T')[0]
  const args   = { season, date, epoch_day: dateParams(date).epoch_day }
  const cacheKey = `${sport}:${ep.dataType}:${qualifierFor(sport, endpoint, args)}`

  // Cache hit proves the pipeline is serving without spending anything.
  const started = Date.now()
  try {
    const { data: cached } = await supabase.rpc('get_cached', { p_cache_key: cacheKey })
    if (cached) {
      return finish({
        ...base, provider: provider.id, ok: true, state: 'cached',
        status: 200, latencyMs: Date.now() - started, source: 'cache',
        detail: 'Serving from cache — endpoint healthy, no upstream call needed.',
      })
    }
  } catch { /* fall through to a live probe */ }

  try {
    const result = await fetchUpstream({
      sport, dataType: ep.dataType, params: { ...dateParams(date), season },
    })
    return finish({
      ...base, provider: provider.id, ok: true, state: 'live',
      status: 200, latencyMs: result.fetchMs, source: 'origin',
      detail: `Live response from ${provider.label}.`,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502
    return finish({
      ...base, provider: provider.id, ok: false, state: 'error',
      status, latencyMs: Date.now() - started, source: 'origin',
      detail: err instanceof Error ? err.message : 'Upstream call failed.',
    })
  }
}

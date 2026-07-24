// src/middleware/gateway.ts
// Runs on every /api/v1/* request.
// Order: key lookup (Supabase) → rate limit (Upstash) → sport access check

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit }                 from '@upstash/ratelimit'
import { Redis }                     from '@upstash/redis'
import { createClient }              from '@supabase/supabase-js'
import { TIERS, type TierName }      from '@/lib/tiers'
import { SPORTS, SPORT_KEYS, getSport } from '@/lib/capabilities'
import { politeRpmFor }              from '@/lib/providers'

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Limits come from lib/tiers.ts so pricing and enforcement can't drift apart.
// Scout costs nothing upstream but still burns an Upstash command per request
// from a hard 10k/day ceiling, which is why the free tier is not unlimited.
const limiters: Record<TierName, Ratelimit> = Object.fromEntries(
  (Object.keys(TIERS) as TierName[]).map(t => [
    t,
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(TIERS[t].rpm, '1 m'),
      prefix:  `rl:${t}`,
    }),
  ])
) as Record<TierName, Ratelimit>

// ─── Per-sport guard for scarce sports ────────────────────────────────────────
// One universal key covers every sport, but upstream quota is provisioned PER
// SPORT and the allocations are wildly uneven: tennis has 300,000/month, MMA has
// 2,500. An Oracle key at 600 req/min could drain MMA's entire month in about
// four minutes of cache-missing requests (each distinct game id is a distinct
// cache key, so caching does not save you here).
//
// Only sports flagged `capacity: 'low'` get this second check. Every extra
// limiter call costs an Upstash command against a hard 10k/day ceiling, so
// spending one on tennis — which has more monthly quota than we could plausibly
// use — would be paying to protect the thing that isn't at risk.
//
// A second reason to throttle exists that has nothing to do with quota: the open
// F1 sources are free and unmetered, so no cost signal would ever slow them down,
// but they are volunteer-run and deserve not to be hammered by a paid product.
// Those providers declare `politeRpm`, and the limit applied is the stricter of
// the two reasons. See providers/types.ts.
const SCARCE_RPM = 10

function guardRpm(sport: { key: string; entitled: boolean; capacity: string }): number | null {
  if (!sport.entitled) return null
  const quotaLimit  = sport.capacity === 'low' ? SCARCE_RPM : undefined
  const courtesy    = politeRpmFor(sport.key)
  const candidates  = [quotaLimit, courtesy].filter((n): n is number => typeof n === 'number')
  return candidates.length ? Math.min(...candidates) : null
}

/** sport -> requests/min, for sports that need a second per-sport check. */
const SPORT_GUARDS = new Map<string, number>(
  SPORTS.map(s => [s.key, guardRpm(s)] as const)
        .filter((e): e is [string, number] => e[1] !== null)
)

// One limiter per distinct rate, built once. Upstash bills per command, not per
// limiter, so this costs nothing extra over the single limiter it replaces.
const guardLimiters = new Map<number, Ratelimit>(
  [...new Set(SPORT_GUARDS.values())].map(rpm => [
    rpm,
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(rpm, '1 m'),
      prefix:  `rl:guard:${rpm}`,
    }),
  ])
)

export interface GatewayContext {
  keyId:     string
  userId:    string
  /** Privy account that owns the key. Rate limits bucket on this, not keyId. */
  accountId: string
  wallet:    string
  tier:      TierName
  sportMask: string[]
  /** Scout keys are served synthetic data and never reach the upstream provider. */
  sandbox:   boolean
  /** False when the key's wallet no longer holds an active stake commitment. */
  commitmentOk: boolean
  /** True when a stake breach suspended this key. Reversible by re-staking. */
  suspended:    boolean
}

// ─── Verified-key cache ───────────────────────────────────────────────────────
// Per-instance, short-lived. Two reasons this exists:
//
//   1. Load. Every request otherwise costs a verify_api_key RPC. Under a burst of
//      concurrent requests the free-tier connection pool saturates and those RPCs
//      start failing — which used to surface to the caller as a bogus 401.
//   2. Latency. Key verification is on the hot path of every single request.
//
// TTL is deliberately short: a revoked key stays usable for at most this long on
// an already-warm instance. 30s is the trade-off between load and revocation lag.
const KEY_TTL_MS = 30_000
const keyCache = new Map<string, { ctx: GatewayContext; expires: number }>()

function cacheGet(rawKey: string): GatewayContext | null {
  const hit = keyCache.get(rawKey)
  if (!hit) return null
  if (Date.now() > hit.expires) { keyCache.delete(rawKey); return null }
  return hit.ctx
}

function cacheSet(rawKey: string, ctx: GatewayContext) {
  // Bound the map so a spray of invalid keys can't grow it without limit.
  if (keyCache.size > 500) keyCache.clear()
  keyCache.set(rawKey, { ctx, expires: Date.now() + KEY_TTL_MS })
}

/** Distinguishes "this key is not valid" from "we could not check right now". */
type VerifyResult =
  | { kind: 'ok';       ctx: GatewayContext }
  | { kind: 'notfound' }
  | { kind: 'unavailable'; detail: string }

async function verifyKey(rawKey: string): Promise<VerifyResult> {
  const cached = cacheGet(rawKey)
  if (cached) return { kind: 'ok', ctx: cached }

  // One retry: pool saturation under burst is usually transient.
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('verify_api_key', { raw_key: rawKey })

    if (!error) {
      if (!data || data.length === 0) return { kind: 'notfound' }
      const k = data[0]
      const tier: TierName = (k.tier ?? 'scout') as TierName
      const ctx: GatewayContext = {
        keyId:     k.key_id,
        userId:    k.user_id,
        // Fall back through privy_id → user_id → keyId. Never leave this
        // undefined: a null bucket would put every caller in one shared limit.
        accountId: k.privy_id ?? k.user_id ?? k.key_id,
        wallet:    k.wallet,
        tier,
        sportMask: k.sport_mask,
        // Derived from the tier rather than stored per key, so repricing a tier
        // can't leave existing keys on the wrong side of the paywall.
        sandbox:      k.is_sandbox ?? TIERS[tier]?.sandbox ?? true,
        commitmentOk: k.commitment_ok ?? true,
        suspended:    k.suspended ?? false,
      }
      cacheSet(rawKey, ctx)

      // Stamp last_used_at only when we actually re-verified, not on every
      // request. Cached hits would otherwise add a write per request and are the
      // reason the pool saturated in the first place.
      supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', ctx.keyId)
        .then(({ error }) => {
          if (error) console.error('[gateway] last_used update failed:', error.message)
        })

      return { kind: 'ok', ctx }
    }

    lastErr = error.message
    if (attempt === 0) await new Promise(r => setTimeout(r, 120))
  }

  // An infrastructure failure is NOT an authentication failure. Saying 401 here
  // tells the caller their key is bad and sends them to rotate a working key.
  return { kind: 'unavailable', detail: lastErr }
}

/**
 * @param sport  Sport to check against the key's mask, or null to skip that
 *               check. MCP passes null: its sport comes from the tool arguments,
 *               so it authenticates and rate-limits here and masks per tool call.
 *               Auth and rate limiting always run — null never means "unguarded".
 */
export async function gateway(
  req:   NextRequest,
  sport: string | null
): Promise<{ context: GatewayContext } | NextResponse> {

  // A sport that does not exist is a 404, not an access problem. Without this,
  // the mask check below tells an agent to "stake additional $DARE" to unlock
  // a sport we do not serve — an invitation to pay for nothing. The sport list
  // is public (see /api/status), so answering before auth leaks nothing.
  if (sport !== null && !SPORT_KEYS.includes(sport)) {
    return errorResponse(404, `Unknown sport "${sport}".`, { supported: SPORT_KEYS })
  }

  const rawKey = req.headers.get('x-oracle-key') ?? req.headers.get('authorization')?.replace('Bearer ', '')

  if (!rawKey) {
    return errorResponse(401, 'Missing API key. Pass via X-Oracle-Key header.')
  }

  const verified = await verifyKey(rawKey)

  if (verified.kind === 'notfound') {
    return errorResponse(401, 'Invalid or revoked API key.')
  }

  if (verified.kind === 'unavailable') {
    console.error('[gateway] key verification unavailable:', verified.detail)
    return new NextResponse(
      JSON.stringify({
        error: 'Unable to verify credentials right now. Retry shortly — your key is unaffected.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }
    )
  }

  const { tier, sportMask: sport_mask, accountId, commitmentOk, suspended } = verified.ctx

  // A paid key whose wallet no longer holds an active commitment is refused.
  // Without this, staking, minting a key and immediately unstaking would buy
  // permanent access — nothing else re-checks between scheduled stake audits.
  //
  // "Suspended" is now literally true: the key row survives and re-staking
  // reactivates this same credential, so the caller does not have to redeploy a
  // new secret to recover. Before, this message was a promise we did not keep.
  if (!commitmentOk || suspended) {
    return errorResponse(
      403,
      'This key requires an active stake. Your $DARE was withdrawn below the tier threshold, ' +
      'so live access is suspended. Re-stake and verify to reactivate this same key.',
      { tier, suspended: true, recoverable: true }
    )
  }

  // Bucket the limit on the ACCOUNT, not the key. Bucketing per key would let one
  // account mint N keys and run N times its tier's rate.
  const limiter = limiters[tier] ?? limiters.scout
  const { success, limit, remaining, reset } = await limiter.limit(accountId)

  if (!success) {
    return new NextResponse(
      JSON.stringify({
        error: 'Rate limit exceeded',
        tier,
        limit,
        reset: new Date(reset).toISOString(),
      }),
      {
        status: 429,
        headers: {
          'Content-Type':          'application/json',
          'X-RateLimit-Limit':     String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(reset),
          'Retry-After':           String(Math.ceil((reset - Date.now()) / 1000)),
        },
      }
    )
  }

  // Per-sport guard. Runs after the tier limit so a caller who is already over
  // their account budget doesn't spend a second Upstash command to be told so
  // twice.
  const guardLimit = sport !== null ? SPORT_GUARDS.get(sport) : undefined
  if (sport !== null && guardLimit !== undefined) {
    const guard = await guardLimiters.get(guardLimit)!.limit(`${accountId}:${sport}`)
    if (!guard.success) {
      // Two different reasons land here and the caller deserves the real one:
      // a small paid allocation, or an open upstream we choose not to hammer.
      const courtesy = politeRpmFor(sport)
      const reason = courtesy === guardLimit
        ? `it is served from open community infrastructure that we rate limit out of courtesy.`
        : `its upstream allocation is small enough that unrestricted polling would exhaust the month.`

      return new NextResponse(
        JSON.stringify({
          error: `${sport.toUpperCase()} is rate limited to ${guardLimit} requests/min per account — ${reason}`,
          sport,
          limit: guardLimit,
          reset: new Date(guard.reset).toISOString(),
        }),
        {
          status: 429,
          headers: {
            'Content-Type':          'application/json',
            'X-RateLimit-Scope':     `sport:${sport}`,
            'X-RateLimit-Limit':     String(guardLimit),
            'X-RateLimit-Remaining': '0',
            'Retry-After':           String(Math.ceil((guard.reset - Date.now()) / 1000)),
          },
        }
      )
    }
  }

  if (sport !== null && !sport_mask.includes(sport)) {
    // Registered but unentitled (NASCAR, the publisher-locked esports titles):
    // no amount of staking unlocks these, so saying "stake more" would be a lie.
    // The mask message is reserved for sports a stake can actually buy.
    const spec = getSport(sport)
    if (spec && !spec.entitled) {
      return errorResponse(
        403,
        `${spec.label} is not currently served.`,
        { sport, status: spec.status, note: spec.note }
      )
    }
    return errorResponse(
      403,
      `Your API key does not include access to ${sport.toUpperCase()}. ` +
      `Stake additional $DARE to unlock this sport.`,
      { sport, sport_mask, tier }
    )
  }

  // suppress unused warning
  void remaining

  return { context: verified.ctx }
}

function errorResponse(status: number, message: string, extra?: object): NextResponse {
  return new NextResponse(
    JSON.stringify({ error: message, ...extra }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

export function guardInternal(req: NextRequest): boolean {
  const secret = req.headers.get('x-internal-secret')
  return secret === process.env.INTERNAL_CRON_SECRET
}

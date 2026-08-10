// src/lib/serve.ts
// Shared cache-first request pipeline used by every /api/v1/* data route.
//
// Three layers of caching, cheapest first:
//
//   1. Vercel edge (CDN)  — repeat requests never invoke this function at all.
//                           Zero Supabase egress, zero Upstash command, zero credit.
//   2. Supabase cache     — one row serves every caller until expires_at.
//   3. Sportradar         — only on a genuine miss.
//
// The edge layer is keyed by URL *and* X-Oracle-Key (via Vary). That matters:
// without Vary the CDN would key on URL alone and could hand licensed Sportradar
// data to an unauthenticated request, bypassing both the licence and the staking
// gate. Per-key edge caching is slightly less efficient but is the only safe form.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { gateway, GatewayContext }   from '@/middleware/gateway'
import { fetchAndCache }             from '@/lib/upstream'
import { resolve, isOpenAndFree }    from '@/lib/providers'
import { sandboxPayload }            from '@/lib/sandbox'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ServeOptions {
  req:       NextRequest
  sport:     string
  dataType:  string
  /** Cache-key qualifier, e.g. a season, date, or game id. */
  qualifier: string
  ttl:       number
  params:    Record<string, string>
  /** Extra fields echoed into the response envelope. */
  echo?:     Record<string, string>
  /** Return a NextResponse to short-circuit before any Sportradar call. */
  preflight?: (ctx: GatewayContext) => NextResponse | null
}

// ─── Edge cache headers ───────────────────────────────────────────────────────
// s-maxage lets the CDN serve the response without invoking the function.
// stale-while-revalidate keeps serving a slightly stale copy while it refreshes,
// so a cache expiry never turns into a latency spike for the caller.
function cacheHeaders(ttl: number, hit: boolean): HeadersInit {
  return {
    'X-Cache':       hit ? 'HIT' : 'MISS',
    'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
    'Vary':          'X-Oracle-Key',
  }
}

// ─── Payload shaping ──────────────────────────────────────────────────────────
// Supabase gzips on the wire (measured 7.4x), so egress is far smaller than raw
// JSON suggests — injuries is ~6KB, not 53KB. What actually dominates the 5GB
// egress budget is a handful of very large documents: leaders is 458KB *compressed*,
// season schedules ~120KB, play-by-play similar. Two levers, both opt-in:
//
//   ?fields=a,b   keep only these top-level branches
//   ?limit=N      truncate arrays to N entries (applied one level deep too)
//
// Neither changes default behaviour — an unmodified client still gets the full
// document — so this can't silently break an existing integration.

interface Shaped { data: unknown; trimmed: boolean; truncated: boolean }

function truncateArrays(value: unknown, limit: number, depth = 0): { value: unknown; hit: boolean } {
  if (depth > 2) return { value, hit: false }

  if (Array.isArray(value)) {
    const cut = value.length > limit
    const arr = (cut ? value.slice(0, limit) : value)
      .map(v => truncateArrays(v, limit, depth + 1).value)
    return { value: arr, hit: cut }
  }

  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let hit = false
    for (const [k, v] of Object.entries(src)) {
      const r = truncateArrays(v, limit, depth + 1)
      out[k] = r.value
      hit = hit || r.hit
    }
    return { value: out, hit }
  }

  return { value, hit: false }
}

function shape(data: unknown, fields: string | null, limitRaw: string | null): Shaped {
  let out = data
  let trimmed = false

  if (fields && typeof out === 'object' && out !== null) {
    const wanted = fields.split(',').map(f => f.trim()).filter(Boolean)
    if (wanted.length) {
      const src = out as Record<string, unknown>
      const picked: Record<string, unknown> = {}
      for (const f of wanted) if (f in src) picked[f] = src[f]
      // Asking for keys that don't exist returns the original rather than a
      // silently empty object — an empty response looks like missing data.
      if (Object.keys(picked).length) { out = picked; trimmed = true }
    }
  }

  let truncated = false
  const limit = limitRaw ? parseInt(limitRaw, 10) : NaN
  if (Number.isFinite(limit) && limit > 0) {
    const r = truncateArrays(out, limit)
    out = r.value
    truncated = r.hit
  }

  return { data: out, trimmed, truncated }
}

export async function serveCached(opts: ServeOptions): Promise<NextResponse> {
  const { req, sport, dataType, qualifier, ttl, params, echo = {}, preflight } = opts
  const start  = Date.now()
  const qs     = new URL(req.url).searchParams
  const fields = qs.get('fields')
  const limit  = qs.get('limit')

  // 1. Auth + rate limit + sport-mask check
  const auth = await gateway(req, sport)
  if (auth instanceof NextResponse) return auth
  const { context } = auth

  // 2. Route-specific gate (tier checks, required params, unsupported sports)
  if (preflight) {
    const blocked = preflight(context)
    if (blocked) return blocked
  }

  // 2b. Provider selection. `?provider=` lets a caller route the same sport to a
  //     different upstream; omitted means the sport's default. Validated against
  //     this sport's own option list, so an arbitrary name can't be routed.
  const requested = qs.get('provider')
  const picked    = resolve(sport, dataType, requested)

  if (!picked.ok) {
    const options = picked.options.map(p => ({
      provider: p.id, label: p.label, status: p.status, license: p.license,
    }))
    if (picked.reason === 'unknown-sport') {
      return NextResponse.json({ error: `Unknown sport "${sport}".` }, { status: 404 })
    }
    if (picked.reason === 'unknown-provider') {
      return NextResponse.json(
        { error: `"${requested}" is not a provider for ${sport.toUpperCase()}.`, options },
        { status: 400 }
      )
    }
    // Registered but not serving. 503 rather than 404 — it exists and is
    // documented, and silently falling back to the default would hand the caller
    // data from a source they did not choose, under a licence they did not check.
    return NextResponse.json(
      {
        error:  `${picked.provider!.label} is registered but not currently serving.`,
        reason: picked.provider!.offlineReason,
        provider: picked.provider!.id,
        status: 'offline',
        options,
      },
      { status: 503 }
    )
  }

  const provider = picked.provider

  // 2c. Licence gate. Some upstreams are free and public but publish no terms
  //     permitting commercial redistribution. Serving those inside a paid staking
  //     tier is the actual exposure — not the data itself — so a source marked
  //     `unclear` is available on the free tier only, enforced here rather than
  //     remembered. See providers/types.ts.
  if (provider.license === 'unclear' && context.tier !== 'scout') {
    return NextResponse.json(
      {
        error: `${provider.label} is available on the free tier only — its terms do not ` +
               `clearly permit commercial redistribution.`,
        source: provider.id,
      },
      { status: 451 }
    )
  }

  // Attribution travels with every response. `meta.source` stays the cache layer
  // ('cache' | 'origin' | 'sandbox') so existing consumers are unaffected; the
  // upstream is reported separately.
  const sourceMeta = {
    provider:      provider.id,
    providerLabel: provider.label,
    attribution:   provider.attribution,
    authoritative: provider.authoritative,
  }

  // A non-default provider gets its own cache entry. Without this the router
  // would serve Sportradar's payload to someone who explicitly asked for another
  // source, which is both wrong data and a licence leak. Default requests keep
  // the unsuffixed key so existing warm entries stay valid.
  const cacheKey = picked.isDefault
    ? `${sport}:${dataType}:${qualifier}`
    : `${sport}:${dataType}:${qualifier}@${provider.id}`

  // Shared with every other transport — see isOpenAndFree. This used to be
  // inlined here, which is precisely how the MCP route ended up with no sandbox
  // handling at all and served licensed payloads to free keys.
  const openAndFree = isOpenAndFree(sport, dataType)

  // 2c. Sandbox short-circuit.
  // Scout keys are free, so they must never reach the upstream provider or read
  // licensed data out of the cache. Synthetic payloads mirror the live shapes
  // field-for-field, so an integration built here runs unchanged once upgraded.
  if (context.sandbox && !openAndFree) {
    const synthetic = sandboxPayload(sport, dataType, qualifier)
    const { data, trimmed, truncated } = shape(synthetic, fields, limit)
    logRequest(context, sport, `sandbox:${dataType}`, true, Date.now() - start)
    return NextResponse.json(
      {
        sport, ...echo, data,
        meta: {
          source: 'sandbox', sandbox: true, cacheKey, trimmed, truncated,
          note: 'Synthetic data — shapes match production. Stake $DARE to unlock live data.',
        },
      },
      {
        headers: {
          'X-Cache':       'SANDBOX',
          'X-Sandbox':     'true',
          'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
          'Vary':          'X-Oracle-Key',
        },
      }
    )
  }

  // 3. Supabase cache
  const { data: cached, error: cacheErr } = await supabase.rpc('get_cached', {
    p_cache_key: cacheKey,
  })
  if (cacheErr) console.error(`[${dataType}] cache lookup:`, cacheErr.message)

  if (cached) {
    const { data, trimmed, truncated } = shape(cached, fields, limit)
    logRequest(context, sport, dataType, true, Date.now() - start)
    return NextResponse.json(
      { sport, ...echo, data, meta: { source: 'cache', ...sourceMeta, trimmed, truncated } },
      { headers: cacheHeaders(ttl, true) }
    )
  }

  // 4. Miss — go upstream
  try {
    // Query params are merged in beneath the route's own, so a provider template
    // can require something the generic route never heard of (TxLINE keys on
    // fixture_id, not a date) without every route learning about it. Explicit
    // route params always win.
    const merged = { ...Object.fromEntries(qs), ...params }

    const result = await fetchAndCache(
      { sport, dataType, params: merged, provider: requested },
      cacheKey,
      ttl
    )
    const { data, trimmed, truncated } = shape(result.data, fields, limit)
    logRequest(context, sport, dataType, false, Date.now() - start)
    return NextResponse.json(
      { sport, ...echo, data, meta: { source: 'origin', ...sourceMeta, trimmed, truncated } },
      { headers: cacheHeaders(ttl, false) }
    )
  } catch (err) {
    const msg    = err instanceof Error ? err.message : 'Fetch failed'
    const status = (err as { status?: number }).status ?? 502

    // Budget exhaustion is a service condition, not a client error.
    if (status === 429) {
      logRequest(context, sport, dataType, false, Date.now() - start, 503)
      return NextResponse.json(
        { error: 'Sports data temporarily unavailable — monthly quota reached for this sport.' },
        { status: 503 }
      )
    }

    logRequest(context, sport, dataType, false, Date.now() - start, status)
    return NextResponse.json({ error: msg }, { status })
  }
}

/**
 * Cache-first read that returns raw data instead of a NextResponse.
 *
 * serveCached is the right entry point for a pass-through route. Anything that
 * needs to TRANSFORM the payload before responding — the resolution layer — needs
 * the data, not a response. Both share this so there is exactly one implementation
 * of the cache path.
 *
 * Note this caches the RAW upstream document under the same key the pass-through
 * route uses, so /f1/results and /f1/resolve share one cache entry and one credit.
 * Normalisation is pure CPU and happens on read.
 */
export async function getOrFetch(opts: {
  sport:     string
  dataType:  string
  qualifier: string
  ttl:       number
  params:    Record<string, string>
}): Promise<{ data: Record<string, unknown>; cacheKey: string; fromCache: boolean }> {
  const { sport, dataType, qualifier, ttl, params } = opts
  const cacheKey = `${sport}:${dataType}:${qualifier}`

  const { data: cached, error } = await supabase.rpc('get_cached', { p_cache_key: cacheKey })
  if (error) console.error(`[${dataType}] cache lookup:`, error.message)
  if (cached) return { data: cached as Record<string, unknown>, cacheKey, fromCache: true }

  const result = await fetchAndCache({ sport, dataType, params }, cacheKey, ttl)
  return { data: result.data, cacheKey, fromCache: false }
}

export function logRequest(
  ctx:       GatewayContext,
  sport:     string,
  endpoint:  string,
  cacheHit:  boolean,
  latencyMs: number,
  status = 200
) {
  supabase.rpc('log_request', {
    p_api_key_id:  ctx.keyId,
    p_user_id:     ctx.userId,
    p_sport:       sport,
    p_endpoint:    endpoint,
    p_cache_hit:   cacheHit,
    p_latency_ms:  latencyMs,
    p_status_code: status,
  }).then(({ error }) => {
    if (error) console.error('[log]', error.message)
  })
}

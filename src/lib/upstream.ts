// src/lib/upstream.ts
// Provider-agnostic fetch pipeline. This is the old src/lib/sportradar.ts fetch
// path with the vendor factored out — budget check, fetch, timeout, error
// mapping, request coalescing and cache upsert are all carried over unchanged.
//
// The only behavioural difference: an unmetered provider skips the two budget
// RPCs entirely. A free source should not cost two Supabase round-trips per call
// to prove it is free.

import { createClient } from '@supabase/supabase-js'
import {
  buildUrl,
  resolve,
  UpstreamError,
  SPORT_ENTITLED,
  type Provider,
  type ProviderId,
} from '@/lib/providers'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface FetchOptions {
  sport:    string
  dataType: string
  params?:  Record<string, string>
  /** Explicit `?provider=` selection. Omitted means the sport's default. */
  provider?: string | null
}

export interface UpstreamResult {
  data:      Record<string, unknown>
  fetchMs:   number
  fromCache: boolean
  provider:  ProviderId
  /** Whether this source may mark a result official. Carried into resolution. */
  authoritative: boolean
}

// ─── Budget (metered providers only) ─────────────────────────────────────────
// Quotas are provisioned per sport, not as one shared pool
// (tennis 300k, nhl 235k, mlb 225k, nba 110k, nfl 100k, wnba 55k, mma 2.5k).

async function canCall(sport: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_budget', { p_sport: sport })
  if (error) {
    console.error('[upstream] budget check failed:', error.message)
    return false  // fail safe — never spend when we can't verify headroom
  }
  return data === true
}

async function incrementBudget(sport: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('increment_budget', { p_sport: sport })
  if (error) {
    console.error('[upstream] budget increment failed:', error.message)
    return false
  }
  return data === true
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchUpstream(options: FetchOptions): Promise<UpstreamResult> {
  const { sport, dataType, params = {}, provider: preferred } = options

  const picked = resolve(sport, dataType, preferred)
  if (!picked.ok) {
    const names = picked.options.map(p => `${p.id}${p.status === 'offline' ? ' (offline)' : ''}`)
    if (picked.reason === 'unknown-sport') {
      throw new UpstreamError(`No provider configured for sport "${sport}".`, 404, sport, dataType)
    }
    if (picked.reason === 'unknown-provider') {
      throw new UpstreamError(
        `"${preferred}" is not a provider for ${sport.toUpperCase()}. Available: ${names.join(', ')}.`,
        400, sport, dataType
      )
    }
    // Offline is 503, not 404: the route exists and is documented, it is simply
    // not serving yet. A caller can reasonably retry after we switch it on.
    throw new UpstreamError(
      `${picked.provider!.label} is registered but not serving. ${picked.provider!.offlineReason ?? ''}`.trim(),
      503, sport, dataType, picked.provider!.id
    )
  }

  const provider: Provider = picked.provider

  // Fail fast on sports the Sportradar key can't reach — a 403 costs a credit and
  // tells the caller nothing useful. Only applies to that provider; open sources
  // have no entitlement concept.
  if (provider.id === 'sportradar' && SPORT_ENTITLED[sport] === false) {
    throw new UpstreamError(
      `${sport.toUpperCase()} is not available on this plan.`,
      403, sport, dataType, provider.id
    )
  }

  if (provider.metered && !(await canCall(sport))) {
    throw new UpstreamError(
      `Monthly ${sport.toUpperCase()} quota exhausted or in cache-only mode`,
      429, sport, dataType, provider.id
    )
  }

  // Resolved once per request and passed into both the URL and the headers.
  // Async because some providers mint short-lived session tokens at runtime.
  let auth
  try {
    auth = await provider.auth?.()
  } catch (err) {
    throw new UpstreamError(
      `Could not obtain credentials for ${provider.label}: ${(err as Error).message}`,
      502, sport, dataType, provider.id
    )
  }

  const url = buildUrl(provider, dataType, params, sport, auth)

  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 7000)
  const start      = Date.now()

  let response: Response
  try {
    response = await fetch(url, {
      signal:  controller.signal,
      headers: { 'Accept': 'application/json', ...(auth?.headers ?? {}) },
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new UpstreamError(
        `Upstream request timed out after 7s (${sport}/${dataType} via ${provider.label})`,
        504, sport, dataType, provider.id
      )
    }
    throw new UpstreamError(
      `Upstream fetch failed: ${(err as Error).message}`,
      502, sport, dataType, provider.id
    )
  } finally {
    clearTimeout(timeout)
  }

  const fetchMs = Date.now() - start

  if (!response.ok) {
    if (response.status === 429) {
      console.warn(`[upstream] rate limited on ${sport}/${dataType} via ${provider.label}`)
    }
    throw new UpstreamError(
      `Upstream returned ${response.status} for ${sport}/${dataType} via ${provider.label}`,
      response.status, sport, dataType, provider.id
    )
  }

  let data: Record<string, unknown>
  try {
    data = await response.json()
  } catch {
    throw new UpstreamError(
      `Upstream returned invalid JSON for ${sport}/${dataType} via ${provider.label}`,
      502, sport, dataType, provider.id
    )
  }

  // Projection, before anything else sees the payload — this is what gets cached
  // and returned. A provider uses it to drop bulk it does not need or text it may
  // not store. See `project` in providers/types.ts.
  //
  // A throw here is a bug in the projector, not an upstream fault, and silently
  // caching the unprojected document would defeat the point (it could be the very
  // thing we must not store), so this fails the request loudly.
  if (provider.project) {
    try {
      data = provider.project(data, dataType) as Record<string, unknown>
    } catch (err) {
      throw new UpstreamError(
        `Could not project ${sport}/${dataType} from ${provider.label}: ${(err as Error).message}`,
        502, sport, dataType, provider.id
      )
    }
  }

  if (provider.metered) {
    incrementBudget(sport).catch(err =>
      console.error('[upstream] failed to increment budget:', err)
    )
  }

  console.log(`[upstream] ${sport}/${dataType} via ${provider.id} — ${fetchMs}ms`)

  return { data, fetchMs, fromCache: false, provider: provider.id, authoritative: provider.authoritative }
}

// ─── Request coalescing ───────────────────────────────────────────────────────
// When a popular cache key expires, every concurrent request misses at once and
// each one independently calls upstream. Measured: 25 concurrent cold requests
// produced 17 duplicate fetches of the same document — 17x the quota cost for one
// document, and a burst that can trip Sportradar's 25 QPS ceiling.
//
// Callers that arrive while a fetch for the same key is already in flight now
// await that same promise instead of starting their own.
const inFlight = new Map<string, Promise<UpstreamResult>>()

export async function fetchAndCache(
  options:    FetchOptions,
  cacheKey:   string,
  ttlSeconds: number
): Promise<UpstreamResult> {
  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const work = doFetchAndCache(options, cacheKey, ttlSeconds)
  inFlight.set(cacheKey, work)
  try {
    return await work
  } finally {
    inFlight.delete(cacheKey)
  }
}

async function doFetchAndCache(
  options:    FetchOptions,
  cacheKey:   string,
  ttlSeconds: number
): Promise<UpstreamResult> {
  const result  = await fetchUpstream(options)
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString()

  supabase.rpc('upsert_cache', {
    p_sport:      options.sport,
    p_data_type:  options.dataType,
    p_cache_key:  cacheKey,
    p_payload:    result.data,
    p_expires_at: expires,
    p_fetch_ms:   result.fetchMs,
    p_source:     result.provider,
  }).then(({ error }) => {
    if (error) console.error('[cache] upsert failed:', error.message)
  })

  return result
}

/**
 * Re-stamps an existing cache entry with a new lifetime.
 *
 * Used by the resolution layer: a result is cached briefly while it is still
 * provisional, then promoted to a long TTL the moment it becomes official —
 * an official classification is immutable, so re-fetching it ever again is pure
 * waste. Fire-and-forget; a failed promotion just means a needless refetch later.
 */
export function recacheWithTtl(
  sport:      string,
  dataType:   string,
  cacheKey:   string,
  payload:    Record<string, unknown>,
  ttlSeconds: number,
  provider:   ProviderId
): void {
  supabase.rpc('upsert_cache', {
    p_sport:      sport,
    p_data_type:  dataType,
    p_cache_key:  cacheKey,
    p_payload:    payload,
    p_expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    p_fetch_ms:   0,
    p_source:     provider,
  }).then(({ error }) => {
    if (error) console.error('[cache] ttl promotion failed:', error.message)
  })
}

// ─── Season helpers ───────────────────────────────────────────────────────────

export function currentSeason(sport: string): string {
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  switch (sport) {
    case 'nhl':
    case 'nba':
    case 'wnba':
    case 'nba_gleague':
      return month >= 10 ? `${year}` : `${year - 1}`
    case 'nfl':
      return month >= 9 ? `${year}` : `${year - 1}`
    // Calendar-year seasons: mlb, nascar, tennis, mma, f1
    default:
      return `${year}`
  }
}

/**
 * Expands a YYYY-MM-DD string into the param set every endpoint template needs.
 * Daily Sportradar endpoints want separate {year}/{month}/{day} segments, while
 * tennis/mma v2/v3 want a single {date}. Supplying all four covers both shapes.
 */
export function dateParams(date: string): Record<string, string> {
  const [year, month, day] = date.split('-')
  // epoch_day (days since the Unix epoch) is how TxLINE addresses its fixture
  // window. Derived here so every date-taking route supplies it for free.
  const epoch_day = String(Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86400000))
  return { date, year, month, day, epoch_day }
}

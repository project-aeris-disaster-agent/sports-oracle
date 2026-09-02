// src/app/api/internal/warm/route.ts
// Pre-populates the cache ahead of demand, driven by the cache-warmup workflow.
//
// Works in ENDPOINT PATH space (`schedule`, `standings`, `scores`, …), not raw
// upstream dataTypes. The path is what the capability manifest is keyed on, so
// TTL, dataType and cache qualifier all come from the same place the live routes
// use — a warmed entry therefore lands on exactly the key a real request will
// look for. This module previously carried its own TTL table, which was the third
// copy in the codebase and disagreed with the other two.
//
// Requesting a path a sport does not expose is skipped rather than attempted:
// F1 has no /roster, and firing that at the upstream would produce a guaranteed
// error for every warm run.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { fetchAndCache, currentSeason, dateParams } from '@/lib/upstream'
import { guardInternal }             from '@/middleware/gateway'
import { getSport, getEndpoint }     from '@/lib/capabilities'
import { qualifierFor }              from '@/lib/cache-key'
import { resolve, missingParams }    from '@/lib/providers'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  if (!guardInternal(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body  = await req.json().catch(() => ({}))
  const sport = body.sport as string
  const paths = body.types as string[]
  const force = (body.force as boolean) ?? false

  if (!sport || !paths?.length) {
    return NextResponse.json({ error: 'sport and types required' }, { status: 400 })
  }

  const spec = getSport(sport)
  if (!spec) {
    return NextResponse.json({ error: `Unknown sport "${sport}".` }, { status: 404 })
  }
  if (!spec.entitled) {
    return NextResponse.json({ sport, skipped: 'not entitled', results: {} })
  }

  const season = currentSeason(sport)
  const today  = new Date().toISOString().split('T')[0]
  const results: Record<string, string> = {}

  for (const path of paths) {
    const endpoint = getEndpoint(sport, path)
    if (!endpoint) {
      results[path] = 'skipped (not offered by this sport)'
      continue
    }

    // The qualifier and the upstream request MUST be built from the same params.
    //
    // They were not. The qualifier got `{ season, date }` while the fetch got the
    // full `dateParams(today)`, which also carries `epoch_day`. Soccer keys its
    // schedule on epoch_day (cache-key.ts), so warming computed the qualifier with
    // epoch_day UNDEFINED and fell through to the date string: every warm run
    // wrote `soccer:schedule:2026-09-02` while every real request read
    // `soccer:schedule:20699`. The entry was never read by anything, so soccer
    // paid a full cold upstream fetch on every first request despite being warmed
    // hourly. Building both from one object is what makes that class of drift
    // impossible rather than merely fixed.
    const warmParams = { ...dateParams(today), season }

    // Warming is a blind pre-fetch with no caller-supplied ids, so anything keyed
    // on a game/team id can't be warmed usefully — the qualifier would be
    // 'missing' and the entry would never be read.
    const qualifier = qualifierFor(sport, path, warmParams)
    if (!qualifier || qualifier === 'missing') {
      results[path] = 'skipped (needs a request-specific id)'
      continue
    }

    // Second, independent check: the cache qualifier can be satisfiable while the
    // upstream path template is not. NFL injuries is the live example — the
    // qualifier defaults to week 1, but `{week}` in the path stays unfilled and
    // the fetch throws. Ask the template what it actually needs.
    const picked = resolve(sport, endpoint.dataType)
    if (picked.ok) {
      const missing = missingParams(picked.provider, endpoint.dataType, warmParams, sport)
      if (missing.length) {
        results[path] = `skipped (needs ${missing.join(', ')})`
        continue
      }
    }

    try {
      const cacheKey = `${sport}:${endpoint.dataType}:${qualifier}`

      if (!force) {
        const { data: cached } = await supabase.rpc('get_cached', { p_cache_key: cacheKey })
        if (cached) {
          results[path] = 'skipped (fresh)'
          continue
        }
      }

      await fetchAndCache(
        { sport, dataType: endpoint.dataType, params: warmParams },
        cacheKey,
        endpoint.ttl
      )

      results[path] = 'warmed'
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      results[path] = `error: ${msg}`
      console.error(`[warm] ${sport}/${path} failed:`, msg)
    }
  }

  return NextResponse.json({ sport, season, results })
}

// src/lib/settlement-feed.ts
// One reader for the settlement transition feed, shared by REST and MCP.
//
// The REST route carried this query inline. The MCP transport special-cases
// `events` and `resolve` and hands everything else to the generic upstream
// fetch, so a `get_settlements` tool would have tried to fetch a dataType called
// "settlements" from Sportradar. Same lesson as resolve-dispatch: one
// implementation, two transports.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const FEED_DEFAULT_LIMIT = 200
export const FEED_MAX_LIMIT     = 1000
/** Without `since`, how far back the first page reaches. */
export const FEED_DEFAULT_WINDOW_MS = 24 * 3600 * 1000

export interface FeedQuery {
  since?:    string | null
  revised?:  boolean
  official?: boolean
  limit?:    number | string | null
}

export type FeedResult =
  | { ok: false; error: string }
  | { ok: true; body: Record<string, unknown> }

export async function readSettlementFeed(sport: string, q: FeedQuery): Promise<FeedResult> {
  const limit = Math.min(FEED_MAX_LIMIT, Math.max(1, Number(q.limit ?? FEED_DEFAULT_LIMIT) || FEED_DEFAULT_LIMIT))

  let since: string
  if (q.since) {
    const t = new Date(q.since)
    if (Number.isNaN(t.getTime())) {
      return { ok: false, error: 'since must be an ISO-8601 timestamp or a previous next_since.' }
    }
    since = t.toISOString()
  } else {
    since = new Date(Date.now() - FEED_DEFAULT_WINDOW_MS).toISOString()
  }

  let query = supabase
    .from('settlement_observations')
    .select('id, event_id, status, official, winner_id, void_reason, prev_status, prev_official, revised, source, resolution, observed_at')
    .eq('sport', sport)
    .gt('observed_at', since)
    .order('observed_at', { ascending: true })
    .order('id',          { ascending: true })
    .limit(limit)
  if (q.revised)  query = query.eq('revised', true)
  if (q.official) query = query.eq('official', true)

  const { data, error } = await query
  if (error) return { ok: false, error: 'Could not read the settlement feed.' }

  const rows = data ?? []
  const last = rows[rows.length - 1]

  return {
    ok: true,
    body: {
      sport,
      since,
      count:      rows.length,
      // Pass this back as `since` to continue. Unchanged when the page is empty,
      // so a quiet slate polls the same cursor rather than drifting forward and
      // skipping a transition that lands between polls.
      next_since: last ? last.observed_at : since,
      has_more:   rows.length === limit,
      transitions: rows.map(r => ({
        observation_id: r.id,
        event_id:       r.event_id,
        observed_at:    r.observed_at,
        from:           r.prev_status ?? null,
        to:             r.status,
        official:       r.official,
        revised:        r.revised,
        winner_id:      r.winner_id,
        void_reason:    r.void_reason,
        // Restated per row so a consumer cannot act on a provisional transition
        // by accident. A revision is never settleable from this feed: it needs a
        // human, and the flag is there to summon one.
        settleable:     r.official && !r.revised,
        resolution:     r.resolution,
      })),
      note: 'Only transitions are listed. An event that has not changed since your cursor is absent, not unresolved.',
    },
  }
}

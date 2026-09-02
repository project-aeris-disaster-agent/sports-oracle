// src/app/api/auth/webhooks/route.ts
// Webhook subscriptions: register a URL to be POSTed settlement transitions.
//
// Authenticated with the Privy session, like key management, because a webhook
// is an account-level resource: it outlives any one key and is bound to the
// account's sports entitlement, not to a credential that can be rotated.
//
//   GET     list this account's subscriptions (secrets are never returned)
//   POST    { url, sports?: string[], events?: string[] }  -> { id, secret, ... }
//   DELETE  { id }
//
// The signing secret is generated here and returned exactly once, like a raw API
// key. Deliveries carry `X-Oracle-Signature: sha256=<hmac of body>`; see
// api/internal/settlement-watch for the payload.
//
// Sandbox accounts may subscribe, but they will only ever receive events for
// sports whose settlement source is open and free, for the same reason /resolve
// refuses them licensed outcomes: a webhook is just another transport.

import { NextRequest, NextResponse } from 'next/server'
import { PrivyClient }               from '@privy-io/server-auth'
import { createClient }              from '@supabase/supabase-js'
import crypto                        from 'crypto'
import { RESOLVABLE }                from '@/lib/resolution'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const EVENTS      = ['official', 'void', 'revised', 'provisional'] as const
const MAX_PER_ACCOUNT = 5

async function authed(req: NextRequest): Promise<string | NextResponse> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Missing authorization header' }, { status: 401 })
  try {
    return (await privy.verifyAuthToken(token)).userId
  } catch {
    return NextResponse.json({ error: 'Invalid Privy token' }, { status: 401 })
  }
}

export async function GET(req: NextRequest) {
  const who = await authed(req)
  if (who instanceof NextResponse) return who

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, sports, events, is_active, failures, last_success_at, last_failure_at, created_at')
    .eq('privy_id', who)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Could not list webhooks' }, { status: 500 })

  return NextResponse.json({ webhooks: data ?? [], events: EVENTS, sports: RESOLVABLE })
}

export async function POST(req: NextRequest) {
  const who = await authed(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as { url?: string; sports?: unknown; events?: unknown }

  // Only https, and never a private or loopback host: this service will POST
  // to whatever is registered, from our infrastructure, and an internal address
  // here is an SSRF primitive.
  let url: URL
  try { url = new URL(String(body.url ?? '')) } catch {
    return NextResponse.json({ error: 'url must be an absolute https URL' }, { status: 400 })
  }
  if (url.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|\[fc|\[fd)/i.test(url.hostname)) {
    return NextResponse.json({ error: 'url must be https and publicly routable' }, { status: 400 })
  }

  const sports = Array.isArray(body.sports) ? body.sports.map(s => String(s).toLowerCase()) : []
  const unknownSport = sports.find(s => !RESOLVABLE.includes(s))
  if (unknownSport) {
    return NextResponse.json({ error: `"${unknownSport}" has no settlement feed`, supported: RESOLVABLE }, { status: 400 })
  }

  const events = Array.isArray(body.events) && body.events.length
    ? body.events.map(e => String(e).toLowerCase())
    : ['official', 'void', 'revised']
  const unknownEvent = events.find(e => !(EVENTS as readonly string[]).includes(e))
  if (unknownEvent) {
    return NextResponse.json({ error: `Unknown event "${unknownEvent}"`, supported: EVENTS }, { status: 400 })
  }

  const { count } = await supabase
    .from('webhook_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('privy_id', who).eq('is_active', true)
  if ((count ?? 0) >= MAX_PER_ACCOUNT) {
    return NextResponse.json({ error: `At most ${MAX_PER_ACCOUNT} active webhooks per account` }, { status: 409 })
  }

  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex')
  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .insert({ privy_id: who, url: url.toString(), secret, sports, events })
    .select('id, url, sports, events, created_at')
    .single()
  if (error || !data) {
    console.error('[webhooks]', error?.message)
    return NextResponse.json({ error: 'Could not create webhook' }, { status: 500 })
  }

  return NextResponse.json({
    ...data,
    // Shown once. Verify deliveries with HMAC-SHA256(secret, raw body) and
    // compare to X-Oracle-Signature.
    secret,
    signature: 'X-Oracle-Signature: sha256=<hex hmac-sha256 of the raw request body>',
    note: 'Store the secret now; it is not retrievable later.',
  }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const who = await authed(req)
  if (who instanceof NextResponse) return who

  const { id } = await req.json().catch(() => ({})) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error, count } = await supabase
    .from('webhook_subscriptions')
    .delete({ count: 'exact' })
    .eq('id', id).eq('privy_id', who)
  if (error) return NextResponse.json({ error: 'Could not delete webhook' }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ deleted: id })
}

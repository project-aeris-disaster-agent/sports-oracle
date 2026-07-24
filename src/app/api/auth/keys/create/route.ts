// src/app/api/auth/keys/create/route.ts
// Issues an API key at whatever tier the caller's stake currently supports.
//
// Scout requires no stake and no wallet — it issues a sandbox key immediately, so
// an agent can be built and tested before any capital is committed. Analyst and
// Oracle require a verified on-chain stake.

import { NextRequest, NextResponse } from 'next/server'
import { PrivyClient }               from '@privy-io/server-auth'
import { createClient }              from '@supabase/supabase-js'
import crypto                        from 'crypto'
import { TIERS, type TierName }      from '@/lib/tiers'
import { ENTITLED_SPORTS }           from '@/lib/capabilities'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALL_SPORTS = ENTITLED_SPORTS.map(s => s.key)

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization header' }, { status: 401 })
  }

  let privyUserId: string
  try {
    privyUserId = (await privy.verifyAuthToken(token)).userId
  } catch {
    return NextResponse.json({ error: 'Invalid Privy token' }, { status: 401 })
  }

  // ── Universal key ─────────────────────────────────────────────────────────
  // One key covers every entitled sport. Splitting access per sport was
  // considered and rejected: the rate limit is bucketed per ACCOUNT, so extra
  // keys buy no extra throughput, and a caller juggling seven credentials gains
  // nothing but a way to misconfigure one of them.
  //
  // The sport_mask column stays an array rather than being dropped, because it
  // is what lets a newly-entitled sport (NASCAR, G League) be granted without a
  // schema change — and it is still the enforcement point in the gateway.
  await req.json().catch(() => ({}))
  const sportMask = ALL_SPORTS

  // ── Determine tier from the current staker session ────────────────────────
  // Absence of a session is not an error: it means no stake, which means Scout.
  const { data: session } = await supabase
    .from('staker_sessions')
    .select('tier, wallet, unlock_at')
    .eq('privy_id', privyUserId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  const tier: TierName = (session?.tier && session.tier !== 'none')
    ? session.tier as TierName
    : 'scout'
  const config = TIERS[tier]

  // Scout has no wallet requirement, so fall back to a stable placeholder — the
  // column is NOT NULL and the key is identified by privy_id regardless.
  const wallet = session?.wallet ?? `sandbox:${privyUserId}`


  // ── Mint ──────────────────────────────────────────────────────────────────
  const rawKey  = `sk_${config.sandbox ? 'test' : 'live'}_${crypto.randomBytes(16).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const prefix  = rawKey.slice(0, 12)

  const { data: inserted, error } = await supabase
    .from('api_keys')
    .insert({
      privy_id:   privyUserId,
      wallet,
      tier,
      key_hash:   keyHash,
      key_prefix: prefix,
      sport_mask: sportMask,
      is_active:  true,
      is_sandbox: config.sandbox,
    })
    .select('id')
    .single()

  if (error || !inserted) {
    console.error('[keys/create]', error?.message)
    return NextResponse.json({ error: 'Could not create key' }, { status: 500 })
  }

  // Raw key is returned exactly once and never stored.
  return NextResponse.json({
    key:        rawKey,
    prefix,
    tier,
    tierLabel:  config.label,
    sportMask,
    sandbox:    config.sandbox,
    rpm:        config.rpm,
    realtime:   config.realtime,
    lockedUntil: session?.unlock_at ?? null,
    keyId:      inserted.id,
    note: config.sandbox
      ? 'Sandbox key — synthetic data with production-identical shapes. Stake $DARE to unlock live data.'
      : `Live key. No lock-up — unstake whenever you like; this key works for as long as the wallet holds at least ${config.stake.toLocaleString()} $DARE, and is suspended (not destroyed) below that.`,
  })
}

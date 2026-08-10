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
import { TIERS, TIER_ORDER, type TierName } from '@/lib/tiers'
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

  // ── Determine tier ────────────────────────────────────────────────────────
  // A staker session is a short-lived verification receipt. Its ABSENCE means
  // "not verified in the last few minutes" — it does NOT mean "not staked". The
  // durable record of a stake is stake_commitments, which is already what
  // verify_api_key gates every request on.
  //
  // Treating the two as equivalent silently downgraded real stakers. An account
  // holding 2,500,000 $DARE against a 1,000,000 requirement minted a free scout
  // sandbox key because it created the key 32 seconds BEFORE running
  // verify-stake — and nothing told it. Any mint outside the session window hit
  // this: stake, walk away, come back later, get a free key and no live data.
  //
  // So: session first (it is the freshest signal), then fall back to an active
  // commitment. Only an account with neither is genuinely Scout.
  const { data: session } = await supabase
    .from('staker_sessions')
    .select('tier, wallet, unlock_at')
    .eq('privy_id', privyUserId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  let tier: TierName = 'scout'
  let stakedWallet: string | null = null

  if (session?.tier && session.tier !== 'none') {
    tier         = session.tier as TierName
    stakedWallet = session.wallet
  } else {
    const { data: commitments } = await supabase
      .from('stake_commitments')
      .select('tier, wallet')
      .eq('privy_id', privyUserId)
      .eq('status', 'active')

    // Highest active commitment wins, should an account hold more than one.
    const best = (commitments ?? [])
      .filter(c => c.tier && c.tier !== 'none' && c.tier in TIERS)
      .sort((a, b) => TIER_ORDER.indexOf(b.tier as TierName) - TIER_ORDER.indexOf(a.tier as TierName))[0]

    if (best) {
      tier         = best.tier as TierName
      stakedWallet = best.wallet
    }
  }

  const config = TIERS[tier]

  // Scout has no wallet requirement, so fall back to a stable placeholder — the
  // column is NOT NULL and the key is identified by privy_id regardless.
  //
  // A paid key MUST carry the staked wallet: verify_api_key derives commitment_ok
  // by matching the key's wallet against the commitment's, so a placeholder here
  // would mint a key the gateway then rejects as non-compliant on every request.
  const wallet = stakedWallet ?? `sandbox:${privyUserId}`


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

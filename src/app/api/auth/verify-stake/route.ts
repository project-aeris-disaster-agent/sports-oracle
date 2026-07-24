// src/app/api/auth/verify-stake/route.ts
// Resolves a Privy account to a staking tier, and maintains its commitment.
//
// Two things make this route security-sensitive:
//
//  1. The wallet is derived from the authenticated Privy account, never from the
//     request body. An earlier version trusted `walletAddress` from the client,
//     which meant anyone could submit a whale's address and be granted that
//     whale's tier. There is now nothing for a caller to forge.
//
//  2. Every verification doubles as a compliance check. The DareStaking contract
//     permits withdraw() at any time, so a commitment cannot be enforced
//     on-chain. If a wallet has dropped below the tier it committed to, its live
//     keys are revoked here and now.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { authenticate, getLinkedWallets } from '@/lib/privy'
import { suspendKeysForWallet, reinstateKeysForWallet } from '@/lib/enforcement'
import { getStakePosition }          from '@/lib/viem'
import { TIERS, tierForStake }       from '@/lib/tiers'
import { ENTITLED_SPORTS }           from '@/lib/capabilities'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALL_SPORTS  = ENTITLED_SPORTS.map(s => s.key)
const SESSION_MS  = 5 * 60 * 1000
/**
 * Floor on how often a client can force a fresh chain read. Staking from the
 * dashboard has to invalidate the cache — otherwise a user watches their new
 * stake not appear for five minutes and stakes again — but an unthrottled
 * `refresh` would also let one tab spin our RPC quota away.
 */
const REFRESH_FLOOR_MS = 10 * 1000

export async function POST(req: NextRequest) {
  const privyUserId = await authenticate(req)
  if (!privyUserId) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }

  // The panel sets this after a stake or unstake transaction confirms, when the
  // cached tier is known to be stale.
  let forceRefresh = false
  try {
    forceRefresh = (await req.json())?.refresh === true
  } catch { /* an empty body is the normal case */ }

  // ── Wallets come from Privy, never from the request ───────────────────────
  // Checking every linked wallet handles the common real case: someone who
  // signed in with Google (and so holds an embedded wallet) but staked from
  // MetaMask. We read them all and use whichever actually holds the stake.
  let linkedWallets: string[]
  try {
    linkedWallets = await getLinkedWallets(privyUserId)
  } catch (err) {
    // Fail closed — without proven ownership we must not grant a tier.
    console.error('[verify-stake] Privy lookup failed:', err)
    return NextResponse.json(
      { error: 'Could not verify your account right now. Try again shortly.' },
      { status: 503 }
    )
  }

  // No wallet is a valid state, not an error: it means Scout, which is free and
  // needs no chain read at all.
  if (linkedWallets.length === 0) {
    await upsertUser(privyUserId, null)
    return NextResponse.json({
      tier: 'scout', stakeAmount: 0, earned: 0, sportMask: ALL_SPORTS,
      wallet: null, wallets: [], lockedUntil: null,
      sandbox: true, rpm: TIERS.scout.rpm,
      message: 'Scout tier. Connect or fund a wallet and stake $DARE to unlock live data.',
    })
  }

  // Reuse a fresh session rather than hitting the chain on every dashboard load.
  const { data: session } = await supabase
    .from('staker_sessions')
    .select('*')
    .in('wallet', linkedWallets)
    .gt('expires_at', new Date().toISOString())
    .order('stake_amount', { ascending: false })
    .limit(1)
    .maybeSingle()

  // A forced refresh skips the cache, but only once the floor has elapsed since
  // the cached read — so a stuck poller degrades to serving cache rather than to
  // an RPC storm.
  const sessionAge = session?.verified_at
    ? Date.now() - new Date(session.verified_at).getTime()
    : Infinity
  const useCache = session && !(forceRefresh && sessionAge >= REFRESH_FLOOR_MS)

  if (useCache && session) {
    const tier = session.tier === 'none' ? 'scout' : session.tier
    return NextResponse.json({
      tier,
      stakeAmount: Number(session.stake_amount ?? 0),
      earned:      0,
      sportMask:   session.sport_mask ?? ALL_SPORTS,
      wallet:      session.wallet,
      wallets:     linkedWallets,
      lockedUntil: session.unlock_at ?? null,
      sandbox:     TIERS[tier as keyof typeof TIERS]?.sandbox ?? true,
      rpm:         TIERS[tier as keyof typeof TIERS]?.rpm,
      cached:      true,
    })
  }

  // ── Read every linked wallet, keep the strongest position ─────────────────
  const positions = await Promise.allSettled(
    linkedWallets.map(async w => ({ wallet: w, ...(await getStakePosition(w)) }))
  )

  const readable = positions
    .filter((p): p is PromiseFulfilledResult<{ wallet: string; staked: number; earned: number; stakedWei: bigint; isNode: boolean }> =>
      p.status === 'fulfilled')
    .map(p => p.value)

  if (readable.length === 0) {
    return NextResponse.json(
      { error: 'Could not read your stake from Base right now. Try again shortly.' },
      { status: 502 }
    )
  }

  const best   = readable.reduce((a, b) => (b.staked > a.staked ? b : a))
  const wallet = best.wallet
  const tier   = tierForStake(best.staked)
  const config = TIERS[tier]

  // ── Compliance: did an existing commitment just break? ────────────────────
  const { data: commitment } = await supabase
    .from('stake_commitments')
    .select('*')
    .eq('wallet', wallet)
    .eq('status', 'active')
    .maybeSingle()

  let suspendedKeys = 0
  let breached      = false

  if (commitment && best.staked < Number(commitment.required)) {
    // Suspend, don't destroy. The commitment goes inactive either way, which is
    // what actually cuts off the gateway; keeping the key row means a user who
    // re-stakes recovers the credential they already deployed instead of having
    // to rotate a new one through their whole stack.
    const result = await suspendKeysForWallet(
      supabase,
      wallet,
      `Stake fell to ${best.staked.toLocaleString()} DARE, below the ${Number(commitment.required).toLocaleString()} required for ${commitment.tier}`
    )
    suspendedKeys = result.count
    breached      = true
  }

  // ── Open or refresh the commitment ────────────────────────────────────────
  let lockedUntil: string | null = null
  let reinstated  = 0
  let walletConflict = false

  if (tier !== 'scout') {
    const { data: rows } = await supabase.rpc('upsert_commitment', {
      p_wallet:    wallet,
      p_privy_id:  privyUserId,
      p_tier:      tier,
      p_staked:    best.staked,
      p_required:  config.stake,
      p_lock_days: config.lockDays,
    })

    // The wallet's stake already backs a different account. Granting the tier
    // here would let one stake pay for two accounts' keys and two rate limits.
    walletConflict = rows?.[0]?.conflict === true

    if (!walletConflict) {
      lockedUntil = rows?.[0]?.unlock_at ?? null
      // A qualifying stake reactivates whatever this wallet had suspended.
      reinstated = await reinstateKeysForWallet(supabase, wallet)
    }
  }

  if (walletConflict) {
    await upsertUser(privyUserId, wallet)
    return NextResponse.json({
      tier: 'scout', stakeAmount: best.staked, earned: best.earned,
      sportMask: ALL_SPORTS, wallet, wallets: readable.map(r => ({ address: r.wallet, staked: r.staked })),
      lockedUntil: null, sandbox: true, rpm: TIERS.scout.rpm,
      warning:
        'This wallet\'s stake is already credited to another account. A stake backs one ' +
        'account at a time — stake from a wallet linked only to this account, or sign in ' +
        'with the account that claimed it.',
    })
  }

  await supabase.from('staker_sessions').upsert({
    wallet,
    privy_id:     privyUserId,
    tier,
    stake_amount: best.staked,
    sport_mask:   ALL_SPORTS,
    verified_at:  new Date().toISOString(),
    expires_at:   new Date(Date.now() + SESSION_MS).toISOString(),
    unlock_at:    lockedUntil,
  }, { onConflict: 'wallet' })

  await upsertUser(privyUserId, wallet)

  return NextResponse.json({
    tier,
    tierLabel:   config.label,
    stakeAmount: best.staked,
    earned:      best.earned,
    sportMask:   ALL_SPORTS,
    wallet,
    // Surfaced so the dashboard can explain *which* wallet was used when an
    // account has several — otherwise a zero balance looks like a bug.
    wallets:     readable.map(r => ({ address: r.wallet, staked: r.staked })),
    lockedUntil,
    lockDays:    config.lockDays,
    sandbox:     config.sandbox,
    rewards:     config.rewards,
    rpm:         config.rpm,
    ...(reinstated > 0 && {
      notice: `${reinstated} suspended key(s) reactivated — the same credentials work again.`,
      reinstatedKeys: reinstated,
    }),
    ...(breached && {
      warning:
        `Your stake no longer meets the ${commitment!.tier} requirement. ` +
        `${suspendedKeys} API key(s) are suspended — re-stake to reactivate them.`,
      suspendedKeys,
    }),
  })
}

async function upsertUser(privyId: string, wallet: string | null) {
  await supabase.from('users').upsert(
    { privy_id: privyId, ...(wallet ? { wallet } : {}), updated_at: new Date().toISOString() },
    { onConflict: 'privy_id' }
  )
}

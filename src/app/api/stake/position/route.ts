// src/app/api/stake/position/route.ts
// Live on-chain state for one of the caller's own wallets, for the stake panel.
//
// The browser could read all of this itself, but routing it through the server
// keeps the paid RPC endpoint out of the bundle and puts every open dashboard
// tab behind one shared rate limit instead of hammering the public Base RPC
// (which starts returning "over rate limit" quickly under polling).
//
// Ownership is enforced the same way as verify-stake: the wallet must be linked
// to the authenticated Privy account. Reading a stranger's balance is not
// especially sensitive, but an open RPC proxy on our credentials is.

import { NextRequest, NextResponse }        from 'next/server'
import { authenticate, getLinkedWallets, ownsWallet } from '@/lib/privy'
import { getWalletStakeState }              from '@/lib/viem'
import { TIERS, tierForStake }              from '@/lib/tiers'
import { STAKING_ADDRESS, DARE_TOKEN_ADDRESS, BASE_CHAIN_ID, toWholeDare } from '@/lib/staking'

export async function GET(req: NextRequest) {
  const privyUserId = await authenticate(req)
  if (!privyUserId) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }

  const requested = req.nextUrl.searchParams.get('wallet')?.trim().toLowerCase()
  if (!requested || !/^0x[0-9a-fA-F]{40}$/.test(requested)) {
    return NextResponse.json({ error: 'A wallet address is required' }, { status: 400 })
  }

  let linked: string[]
  try {
    linked = await getLinkedWallets(privyUserId)
  } catch (err) {
    console.error('[stake/position] Privy lookup failed:', err)
    return NextResponse.json(
      { error: 'Could not verify your account right now. Try again shortly.' },
      { status: 503 }
    )
  }

  if (!ownsWallet(linked, requested)) {
    return NextResponse.json({ error: 'That wallet is not linked to your account' }, { status: 403 })
  }

  let state
  try {
    state = await getWalletStakeState(requested)
  } catch (err) {
    console.error('[stake/position]', err)
    return NextResponse.json(
      { error: 'Could not read your position from Base right now. Try again shortly.' },
      { status: 502 }
    )
  }

  // Whole-DARE mirrors of each figure, because that is the unit the tier
  // thresholds are expressed in and the panel should not re-derive the rounding
  // rule the server actually applies.
  const staked = toWholeDare(state.stakedWei)

  return NextResponse.json({
    wallet:    state.wallet,
    chainId:   BASE_CHAIN_ID,
    contracts: { staking: STAKING_ADDRESS, token: DARE_TOKEN_ADDRESS },

    // Strings: these are uint256 values and JSON numbers would lose precision.
    stakedWei:    state.stakedWei.toString(),
    earnedWei:    state.earnedWei.toString(),
    balanceWei:   state.balanceWei.toString(),
    allowanceWei: state.allowanceWei.toString(),

    staked,
    balance: toWholeDare(state.balanceWei),
    earned:  toWholeDare(state.earnedWei),

    isNode: state.isNode,
    paused: state.paused,

    tier:      tierForStake(staked),
    tierLabel: TIERS[tierForStake(staked)].label,
  })
}

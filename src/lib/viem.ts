// src/lib/viem.ts
// Read-only Base mainnet access to the DareStaking contract.
//
// Contract: 0xAB44D7719753bE8523BeCF7Ea130a4ae16dEa776 (Base, chain 8453)
// Token:    0x07321eAe7b7018A241c97C3E31f072098C3D5bc6 ($DARE, 18 decimals)
//
// NOTE: the balance getter is `stakedBalance(address)`, not `getStake(address)`.
// An earlier version of this file called `getStake`, which does not exist on the
// deployed contract and reverts on every call.

import { createPublicClient, http, getAddress } from 'viem'
import { base } from 'viem/chains'
import {
  STAKING_ADDRESS, DARE_TOKEN_ADDRESS, STAKING_ABI, ERC20_ABI, WEI, usingDefaultAddresses,
} from '@/lib/staking'

// ─── Environment hardening ────────────────────────────────────────────────────
// `??` and `||` both treat a placeholder string as a real value, so a half-filled
// .env silently wins over the intended fallback. That is not hypothetical: with
// STAKING_CONTRACT_ADDRESS left as "0x...your-contract-address", every on-chain
// read throws — which made the stake watcher skip every wallet and revoke nobody.
// A security control that fails open is worse than one that is absent, so these
// values are validated rather than merely defaulted.
//
// Address resolution now lives in lib/staking.ts because the browser needs the
// same values to build stake transactions, and a client/server mismatch would
// send funds to a contract this file never reads.

const PLACEHOLDER = /your-|YOUR_|\.\.\.|xxx|<.*>/i

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (!v || PLACEHOLDER.test(v)) return undefined
  return v
}

const RPC_URL = cleanEnv(process.env.ALCHEMY_BASE_RPC_URL) ?? 'https://mainnet.base.org'

const client = createPublicClient({
  chain:     base,
  transport: http(RPC_URL),
})

/** Exposed for the health check so misconfiguration is visible, not silent. */
export const chainConfig = {
  stakingAddress: STAKING_ADDRESS,
  tokenAddress:   DARE_TOKEN_ADDRESS,
  rpcHost:        (() => { try { return new URL(RPC_URL).host } catch { return 'invalid' } })(),
  usingDefaults:  usingDefaultAddresses,
}

const ABI = STAKING_ABI

/** Staked balance in wei. Throws with a descriptive message if the RPC fails. */
export async function getStakedBalance(walletAddress: string): Promise<bigint> {
  try {
    return await client.readContract({
      address:      STAKING_ADDRESS,
      abi:          ABI,
      functionName: 'stakedBalance',
      args:         [getAddress(walletAddress)],
    })
  } catch (err) {
    throw new Error(
      `Could not read staked balance for ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export interface StakePosition {
  /** Whole $DARE, floored. Safe for tier comparison. */
  staked:   number
  stakedWei: bigint
  /** Unclaimed rewards, whole $DARE. */
  earned:   number
  /** Contract's own NODE flag (its threshold is 2.5M, independent of our tiers). */
  isNode:   boolean
}

/**
 * Reads a wallet's full staking position in one round trip.
 * Reward and node data are best-effort — a failure there must not block tier
 * assignment, which only needs the balance.
 */
export async function getStakePosition(walletAddress: string): Promise<StakePosition> {
  const address = getAddress(walletAddress)

  const [balanceRes, earnedRes, nodeRes] = await Promise.allSettled([
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'stakedBalance', args: [address] }),
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'earned',        args: [address] }),
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'isNodeAccount', args: [address] }),
  ])

  if (balanceRes.status === 'rejected') {
    throw new Error(
      `Could not read staked balance for ${walletAddress}: ${
        balanceRes.reason instanceof Error ? balanceRes.reason.message : String(balanceRes.reason)
      }`
    )
  }

  const stakedWei = balanceRes.value

  return {
    stakedWei,
    staked: Number(stakedWei / WEI),
    earned: earnedRes.status === 'fulfilled' ? Number(earnedRes.value / WEI) : 0,
    isNode: nodeRes.status === 'fulfilled' ? nodeRes.value : false,
  }
}

/** Back-compat alias — prefer getStakedBalance. */
export const getStake = getStakedBalance

// ─── Write-path support ───────────────────────────────────────────────────────
// Everything the stake panel needs to render a form and decide whether an
// approval transaction is required. Read here rather than from the browser so
// the RPC key stays server-side and users share our rate limit rather than
// hammering the public endpoint from every open tab.

export interface WalletStakeState {
  wallet:     string
  /** Wei. Staked position on the contract. */
  stakedWei:  bigint
  /** Wei. Unclaimed rewards. */
  earnedWei:  bigint
  /** Wei. Spendable $DARE in the wallet. */
  balanceWei: bigint
  /** Wei. How much the staking contract may already pull. */
  allowanceWei: bigint
  isNode:     boolean
  /** Contract-level pause. Staking is refused while true. */
  paused:     boolean
}

/**
 * One round trip for the full picture of a wallet's staking position.
 *
 * Balance and allowance are required — without them the panel cannot tell a
 * user why staking would fail — so a failure there is fatal. Rewards, the node
 * flag and the pause switch are decorative by comparison and degrade quietly.
 */
export async function getWalletStakeState(walletAddress: string): Promise<WalletStakeState> {
  const address = getAddress(walletAddress)

  const [staked, earned, balance, allowance, isNode, paused] = await Promise.allSettled([
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'stakedBalance', args: [address] }),
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'earned', args: [address] }),
    client.readContract({ address: DARE_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
    client.readContract({ address: DARE_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [address, STAKING_ADDRESS] }),
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'isNodeAccount', args: [address] }),
    client.readContract({ address: STAKING_ADDRESS, abi: ABI, functionName: 'paused' }),
  ])

  if (staked.status === 'rejected' || balance.status === 'rejected' || allowance.status === 'rejected') {
    const reason = [staked, balance, allowance].find(r => r.status === 'rejected') as PromiseRejectedResult
    throw new Error(
      `Could not read staking state for ${walletAddress}: ${
        reason.reason instanceof Error ? reason.reason.message : String(reason.reason)
      }`
    )
  }

  return {
    wallet:       address,
    stakedWei:    staked.value,
    balanceWei:   balance.value,
    allowanceWei: allowance.value,
    earnedWei:    earned.status === 'fulfilled' ? earned.value : 0n,
    isNode:       isNode.status === 'fulfilled' ? isNode.value : false,
    // Fail *open* on the pause read only: a missed pause costs the user one
    // reverted transaction, whereas wrongly reporting "paused" blocks a working
    // product outright.
    paused:       paused.status === 'fulfilled' ? paused.value : false,
  }
}

/** Receipt lookup for the panel's transaction poller. */
export async function getTxStatus(hash: `0x${string}`): Promise<
  { status: 'pending' } | { status: 'success' | 'reverted'; blockNumber: string }
> {
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    return { status: receipt.status, blockNumber: receipt.blockNumber.toString() }
  } catch {
    // viem throws TransactionReceiptNotFoundError while a transaction is still
    // in the mempool — that is the normal case here, not an error.
    return { status: 'pending' }
  }
}

export { WEI }

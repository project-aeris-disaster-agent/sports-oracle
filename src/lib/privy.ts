// src/lib/privy.ts
// Server-side Privy access, shared by every route that needs to know which
// wallets an authenticated user actually controls.
//
// This exists because the rule it encodes is a security boundary, not a
// convenience: a wallet address is only ever trusted when Privy says it is
// linked to the caller's account. An earlier version of verify-stake took the
// address from the request body, which let anyone claim a whale's tier. Any new
// route that touches a wallet must go through getLinkedWallets rather than
// re-deriving this, so the rule cannot rot in one place while holding in another.

import { NextRequest }  from 'next/server'
import { PrivyClient }  from '@privy-io/server-auth'

export const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

/** Bounds chain reads so a heavily-linked account can't force unbounded work. */
export const MAX_WALLETS = 5

/** Verifies the bearer token. Returns the Privy user id, or null if unusable. */
export async function authenticate(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  try {
    return (await privy.verifyAuthToken(token)).userId
  } catch {
    return null
  }
}

/**
 * Every EVM address linked to the account, lower-cased and de-duplicated.
 *
 * Throws rather than returning an empty list when Privy is unreachable: callers
 * must fail closed. Silently treating "we could not check" as "owns nothing"
 * would revoke tiers during a Privy outage; treating it as "owns everything"
 * would be worse.
 */
export async function getLinkedWallets(privyUserId: string): Promise<string[]> {
  const user = await privy.getUser(privyUserId)
  const addresses = (user.linkedAccounts ?? [])
    .map(a => (a as { address?: string }).address)
    .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
    .map(a => a.toLowerCase())
  return [...new Set(addresses)].slice(0, MAX_WALLETS)
}

/** True when `wallet` is provably the caller's. Case-insensitive. */
export function ownsWallet(linked: string[], wallet: string): boolean {
  return linked.includes(wallet.trim().toLowerCase())
}

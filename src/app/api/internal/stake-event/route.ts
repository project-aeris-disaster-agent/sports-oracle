// src/app/api/internal/stake-event/route.ts
// Near-real-time stake auditing, driven by on-chain events.
//
// The problem this solves: the scheduled watcher is the only thing that notices
// an unstake, and it runs on a GitHub Actions cron (*/10) that routinely drifts
// five to twenty minutes under load. Add the gateway's 30-second key cache and
// the exploit window is "stake, mint a key, unstake, keep querying live data for
// up to half an hour". That window is the entire value of unstaking early.
//
// Pointing an Alchemy (or QuickNode/Tenderly) webhook at this route closes it to
// seconds: the provider posts when the staking contract emits, and we re-audit
// the wallets named in the payload immediately.
//
// Design notes:
//
//  • The payload is UNTRUSTED input, even signed. It is used only to decide WHICH
//    wallets to look at — never what their balance is. Every decision still comes
//    from our own RPC read of stakedBalance(). A forged payload can therefore
//    make us re-check a wallet, which is harmless, but cannot make us grant or
//    revoke anything.
//
//  • Addresses are scraped generically out of the JSON rather than parsed from
//    one provider's schema. Webhook payload shapes differ between providers and
//    change between versions; a missed field would silently disable a security
//    control, which is a worse failure than scanning a few extra addresses.
//
//  • Auth accepts either an HMAC signature or the internal cron secret, so the
//    same route can be driven by a provider webhook or invoked directly.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import crypto                        from 'crypto'
import { guardInternal }             from '@/middleware/gateway'
import { getStakedBalance }          from '@/lib/viem'
import { STAKING_ADDRESS }           from '@/lib/staking'
import { suspendKeysForWallet, markCommitmentAudited } from '@/lib/enforcement'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const WEI = 10n ** 18n

/** Bounds the work one webhook delivery can cause. */
const MAX_WALLETS_PER_EVENT = 25

/**
 * Constant-time HMAC check against the provider's signing key.
 * Alchemy signs the raw body with SHA-256 and sends it as x-alchemy-signature.
 */
function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY
  if (!secret || !header) return false

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const given    = header.replace(/^sha256=/, '').trim()

  // timingSafeEqual throws on a length mismatch, which is itself a rejection.
  if (expected.length !== given.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
  } catch {
    return false
  }
}

/** Every 0x-address in the payload, minus the contracts themselves. */
function extractAddresses(payload: string): string[] {
  const found = payload.match(/0x[0-9a-fA-F]{40}/g) ?? []
  const ignore = new Set([STAKING_ADDRESS.toLowerCase()])
  return [...new Set(found.map(a => a.toLowerCase()))]
    .filter(a => !ignore.has(a) && a !== '0x' + '0'.repeat(40))
}

export async function POST(req: NextRequest) {
  // Read the body as text: the HMAC covers the exact bytes sent, so re-serialising
  // parsed JSON would produce a different digest and fail every valid delivery.
  const rawBody = await req.text()

  const signed   = verifySignature(rawBody, req.headers.get('x-alchemy-signature'))
  const internal = guardInternal(req)
  if (!signed && !internal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const candidates = extractAddresses(rawBody).slice(0, MAX_WALLETS_PER_EVENT)
  if (candidates.length === 0) {
    return NextResponse.json({ checked: 0, note: 'No addresses in payload' })
  }

  // Only wallets we actually have a paid commitment for are worth a chain read.
  // This is also what keeps a spray of unrelated addresses from costing us RPC
  // calls: an address with no commitment is dropped before any network work.
  const { data: commitments, error } = await supabase
    .from('stake_commitments')
    .select('wallet, tier, required')
    .eq('status', 'active')
    .neq('tier', 'scout')
    .in('wallet', candidates)

  if (error) {
    console.error('[stake-event]', error.message)
    return NextResponse.json({ error: 'Could not load commitments' }, { status: 500 })
  }

  const results: Array<Record<string, unknown>> = []
  let suspendedTotal = 0

  for (const row of commitments ?? []) {
    const wallet   = row.wallet as string
    const required = Number(row.required)

    let staked: number
    try {
      staked = Number((await getStakedBalance(wallet)) / WEI)
    } catch (err) {
      // An RPC failure must not suspend anyone — the scheduled watcher retries.
      results.push({ wallet, status: 'skipped', reason: err instanceof Error ? err.message.slice(0, 80) : 'rpc error' })
      continue
    }

    if (staked < required) {
      const result = await suspendKeysForWallet(
        supabase,
        wallet,
        `Withdrawal detected on-chain: ${staked.toLocaleString()} DARE is below the ${required.toLocaleString()} required for ${row.tier}`
      )
      suspendedTotal += result.count
      results.push({ wallet, tier: row.tier, staked, required, status: 'suspended', keys: result.count })
    } else {
      await markCommitmentAudited(supabase, wallet, staked)
      results.push({ wallet, tier: row.tier, staked, required, status: 'ok' })
    }
  }

  return NextResponse.json({
    addressesInPayload: candidates.length,
    checked:            results.length,
    suspendedKeys:      suspendedTotal,
    breaches:           results.filter(r => r.status === 'suspended').length,
    results,
    timestamp:          new Date().toISOString(),
  })
}

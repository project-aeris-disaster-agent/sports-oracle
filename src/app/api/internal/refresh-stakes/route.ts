// src/app/api/internal/refresh-stakes/route.ts
// Stake watcher. Run on a schedule by GitHub Actions.
//
// Why this must exist: commitment rows are only refreshed when a user happens to
// load the dashboard. Between visits, someone can stake, mint a paid key, and
// withdraw — and nothing would notice. The gateway rejects keys whose commitment
// is inactive, but only this job is responsible for marking a commitment inactive
// once the on-chain balance actually drops.
//
// Reads are cheap (one RPC per wallet) and this runs against a bounded batch, so
// it stays comfortably inside free-tier limits.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { guardInternal }             from '@/middleware/gateway'
import { getStakedBalance }          from '@/lib/viem'
import { suspendKeysForWallet, markCommitmentAudited } from '@/lib/enforcement'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const WEI = 10n ** 18n

export async function POST(req: NextRequest) {
  if (!guardInternal(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: rows, error } = await supabase.rpc('commitments_to_audit', { p_limit: 200 })
  if (error) {
    console.error('[refresh-stakes]', error.message)
    return NextResponse.json({ error: 'Could not load commitments' }, { status: 500 })
  }

  const audited: Array<Record<string, unknown>> = []
  let revokedTotal = 0

  for (const row of rows ?? []) {
    const wallet   = row.wallet as string
    const required = Number(row.required)

    let staked: number
    try {
      staked = Number((await getStakedBalance(wallet)) / WEI)
    } catch (err) {
      // An RPC failure must not revoke anyone — skip and retry next run.
      audited.push({ wallet, status: 'skipped', reason: err instanceof Error ? err.message.slice(0, 80) : 'rpc error' })
      continue
    }

    if (staked < required) {
      // Suspends rather than revokes: access stops either way, but the user
      // recovers by re-staking instead of re-deploying a new secret.
      const result = await suspendKeysForWallet(
        supabase,
        wallet,
        `Stake audit: ${staked.toLocaleString()} DARE is below the ${required.toLocaleString()} required for ${row.tier}`
      )
      revokedTotal += result.count
      audited.push({ wallet, tier: row.tier, staked, required, status: 'suspended', keys: result.count, mode: result.mode })
    } else {
      // Still compliant — record the observed balance and stamp the audit clock
      // so this wallet moves to the back of the queue and the next one comes up.
      await markCommitmentAudited(supabase, wallet, staked)
      audited.push({ wallet, tier: row.tier, staked, required, status: 'ok' })
    }
  }

  return NextResponse.json({
    checked:        audited.length,
    suspendedKeys:  revokedTotal,
    breaches:       audited.filter(a => a.status === 'suspended').length,
    skipped:      audited.filter(a => a.status === 'skipped').length,
    audited,
    timestamp:    new Date().toISOString(),
  })
}

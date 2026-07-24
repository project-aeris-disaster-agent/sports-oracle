// src/lib/enforcement.ts
// The one place that decides what happens to a wallet's keys when its stake no
// longer covers its tier.
//
// This exists to remove a deploy-ordering footgun. Migration 007 replaces
// revoke_keys_for_wallet (permanent) with suspend_keys_for_wallet (reversible),
// and if this code ships before the migration is applied, the RPC simply does not
// exist. Supabase returns that as a normal error object rather than throwing, so
// the naive version would log nothing, suspend nobody, and leave paid keys
// working for a wallet that had emptied itself — a security control silently
// failing OPEN during the deploy window.
//
// So: try the reversible path, and if the function is missing, fall back to the
// old permanent one. Either way the stake stops paying for access. Falling back
// to the harsher behaviour is the right direction for a control like this — worst
// case a user has to mint a new key, which is exactly where we were last week.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface EnforcementResult {
  /** Keys affected. */
  count: number
  /** Which path ran — worth logging, since the fallback means 007 is not applied. */
  mode: 'suspended' | 'revoked' | 'failed'
}

export async function suspendKeysForWallet(
  supabase: SupabaseClient,
  wallet:   string,
  reason:   string
): Promise<EnforcementResult> {
  const { data, error } = await supabase.rpc('suspend_keys_for_wallet', {
    p_wallet: wallet,
    p_reason: reason,
  })

  if (!error) return { count: data ?? 0, mode: 'suspended' }

  console.error(
    `[enforcement] suspend_keys_for_wallet unavailable (${error.message}) — ` +
    'falling back to permanent revocation. Apply migration 007.'
  )

  const { data: revoked, error: revokeError } = await supabase.rpc('revoke_keys_for_wallet', {
    p_wallet: wallet,
    p_reason: reason,
  })

  if (revokeError) {
    // Both paths gone means the stake no longer gates anything. Loud, because
    // nothing downstream will notice on its own.
    console.error(`[enforcement] CRITICAL: could not disable keys for ${wallet}: ${revokeError.message}`)
    return { count: 0, mode: 'failed' }
  }

  return { count: revoked ?? 0, mode: 'revoked' }
}

/** Clears a suspension once a stake qualifies again. No-op before migration 007. */
export async function reinstateKeysForWallet(
  supabase: SupabaseClient,
  wallet:   string
): Promise<number> {
  const { data, error } = await supabase.rpc('reinstate_keys_for_wallet', { p_wallet: wallet })
  if (error) return 0
  return data ?? 0
}

/** Advances the audit queue. Tolerates the pre-007 schema. */
export async function markCommitmentAudited(
  supabase: SupabaseClient,
  wallet:   string,
  staked:   number
): Promise<void> {
  const { error } = await supabase.rpc('mark_commitment_audited', {
    p_wallet: wallet,
    p_staked: staked,
  })
  if (!error) return

  // Pre-007: no last_audited_at column, so just record the balance as before.
  await supabase
    .from('stake_commitments')
    .update({ staked_amount: staked })
    .eq('wallet', wallet)
    .eq('status', 'active')
}

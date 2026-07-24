// src/lib/tiers.ts
// Single source of truth for staking tiers, thresholds and limits.
//
// Enforcement model — worth understanding before changing anything here:
//
// This is a SUBSCRIPTION, not a lock-up. Access continues while the stake is
// held and stops when it is withdrawn. There is no minimum term, and the product
// must not claim one.
//
// Two facts make that the only honest description:
//
//  1. The deployed DareStaking contract (0xAB44...a776) has no lock. withdraw()
//     and exit() are callable at any moment — verified against the deployed
//     bytecode, which has no lockDuration/unlockTime/cooldown/stakeTimestamp
//     function at all, and they are not even gated by the owner's pause().
//
//  2. Nothing off-chain enforces a term either. `unlock_at` is written and was
//     once displayed, but no code path compares it to now(): unstaking on day 1
//     and on day 60 produce byte-identical outcomes, and completing a "window"
//     buys no continued access. Both directions are covered by tests.
//
// What IS enforced, continuously, is the THRESHOLD: if the on-chain balance
// falls below the tier's `stake`, that wallet's keys stop working immediately.
//
// Since migration 007 that is a suspension rather than a revocation — the key row
// survives and re-staking reactivates the same credential. Enforcement is
// identical (the gateway refuses the key either way), but a user who unstakes by
// mistake does not have to rotate secrets through their whole stack to recover.
//
// Reward eligibility is a separate, on-chain concern — the contract pays rewards
// on staked balance regardless of what we do here.

export type TierName = 'scout' | 'analyst' | 'oracle'

export interface TierConfig {
  name:        TierName
  label:       string
  /** Whole $DARE required. Scout is free. */
  stake:       number
  /**
   * Recorded tenure window in days, written to stake_commitments.unlock_at.
   *
   * NOT a lock and NOT enforced — see the header. It is kept only because
   * locked_at/unlock_at are the raw material for a future loyalty benefit
   * (continuous-stake duration earning a rate-limit or reward bonus). Do not
   * surface it to users as a commitment, minimum term, or lock-up: none of those
   * exist, and claiming otherwise tells people their tokens are committed when
   * the contract lets them withdraw at will.
   */
  lockDays:    number
  /** Upstash sliding-window limit, requests per minute. */
  rpm:         number
  /** Scout is served synthetic data and never touches the upstream API. */
  sandbox:     boolean
  /** Live game state and play-by-play. */
  realtime:    boolean
  /** Eligible for on-chain staking rewards. */
  rewards:     boolean
  blurb:       string
}

export const TIERS: Record<TierName, TierConfig> = {
  scout: {
    name: 'scout', label: 'Scout',
    stake: 0, lockDays: 0,
    // Free tier costs us nothing upstream, but every request still consumes an
    // Upstash command from a hard 10k/day ceiling — so it is not unlimited.
    rpm: 30,
    sandbox: true, realtime: false, rewards: false,
    blurb: 'Free. Synthetic data with production-identical response shapes — build and test an integration end to end, then swap to live data by upgrading the key.',
  },
  analyst: {
    name: 'analyst', label: 'Analyst',
    stake: 1_000_000, lockDays: 7,
    rpm: 120,
    sandbox: false, realtime: true, rewards: false,
    blurb: 'Live data across all sports, including in-play and play-by-play. No lock-up — withdraw whenever you like; access runs for as long as the stake is held.',
  },
  oracle: {
    name: 'oracle', label: 'Oracle / Node',
    stake: 20_000_000, lockDays: 30,
    rpm: 600,
    sandbox: false, realtime: true, rewards: true,
    blurb: 'Everything in Analyst plus priority rate limits and staking-reward eligibility. No lock-up — withdraw whenever you like; access runs for as long as the stake is held.',
  },
}

export const TIER_ORDER: TierName[] = ['scout', 'analyst', 'oracle']

/** Highest tier a given staked balance qualifies for. Scout needs no stake. */
export function tierForStake(dare: number): TierName {
  if (dare >= TIERS.oracle.stake)  return 'oracle'
  if (dare >= TIERS.analyst.stake) return 'analyst'
  return 'scout'
}

export function rank(t: TierName): number {
  return TIER_ORDER.indexOf(t)
}

/** True when `have` satisfies a minimum tier requirement. */
export function meets(have: TierName, required: TierName): boolean {
  return rank(have) >= rank(required)
}

/**
 * Tenure marker stored alongside a commitment. Nothing reads it back to gate
 * access — see the header before giving it any enforcement meaning.
 */
export function tenureExpiry(tier: TierName, from = new Date()): Date | null {
  const days = TIERS[tier].lockDays
  if (!days) return null
  return new Date(from.getTime() + days * 86_400_000)
}

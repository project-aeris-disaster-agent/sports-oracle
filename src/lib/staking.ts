// src/lib/staking.ts
// Shared contract surface for the DareStaking write path. Imported by BOTH the
// browser (stake panel) and the server (viem.ts, /api/stake/*), so it must stay
// free of server-only imports and secrets.
//
// Everything here was verified against the deployed bytecode on Base rather than
// assumed from a template, because the contract is unverified on Basescan and an
// earlier version of this codebase shipped a getter (`getStake`) that does not
// exist and reverted on every call. What the contract actually exposes:
//
//   stake(uint256)          — pulls tokens via transferFrom; reverts with the
//                             custom error InsufficientAllowance() (0x13be252b)
//                             when the ERC-20 allowance is short. So staking is
//                             always approve-then-stake, two transactions.
//   withdraw(uint256)       — partial unstake. Reverts "Insufficient staked
//                             balance" past your position.
//   exit()                  — full unstake in one call. Safe at a zero balance
//                             (simulated: succeeds, no revert).
//   stakedBalance(address)  — NOT balanceOf. earned(address) also exists.
//   paused()                — staking is gated on this; currently false.
//   NODE_THRESHOLD()        — 2,500,000 DARE. The contract's own node flag; it is
//                             independent of our Analyst/Oracle tiers.
//
// There is NO standalone reward-claim function — getReward/claim/claimRewards
// are all absent from the bytecode. exit() is the only path that closes a
// position, so the UI must not offer a "claim rewards" button that cannot exist.
//
// The contract has no lock-up: withdraw() is callable at any time, and there is
// no minimum term anywhere in the system. What is enforced off-chain is the tier
// THRESHOLD — fall below it and the wallet's keys are suspended until the stake
// returns. See lib/tiers.ts.

// ─── Addresses ────────────────────────────────────────────────────────────────
// Single source of truth for both runtimes. A client/server split here would be
// genuinely dangerous: the user would stake into one contract while the gateway
// read their balance from another, and their keys would never unlock.

const PLACEHOLDER = /your-|YOUR_|\.\.\.|xxx|<.*>/i

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (!v || PLACEHOLDER.test(v)) return undefined
  return v
}

function resolveAddress(candidates: Array<string | undefined>, fallback: string, label: string): `0x${string}` {
  for (const candidate of candidates) {
    const v = cleanEnv(candidate)
    if (!v) continue
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v as `0x${string}`
    console.warn(`[staking] ${label}="${v}" is not a valid address — using ${fallback}`)
  }
  return fallback as `0x${string}`
}

/** Deployed DareStaking on Base. */
const DEFAULT_STAKING = '0xAB44D7719753bE8523BeCF7Ea130a4ae16dEa776'
/** $DARE token (an EIP-1167 proxy; the implementation is a standard ERC-20). */
const DEFAULT_TOKEN = '0x07321eAe7b7018A241c97C3E31f072098C3D5bc6'

// process.env.<non-public> is inlined as undefined in the browser bundle, so the
// NEXT_PUBLIC_ variant is what the client actually sees. The server keeps
// honouring the original server-only names so existing deployments don't move.
export const STAKING_ADDRESS = resolveAddress(
  [process.env.NEXT_PUBLIC_STAKING_CONTRACT_ADDRESS, process.env.STAKING_CONTRACT_ADDRESS],
  DEFAULT_STAKING,
  'STAKING_CONTRACT_ADDRESS'
)

export const DARE_TOKEN_ADDRESS = resolveAddress(
  [process.env.NEXT_PUBLIC_DARE_TOKEN_ADDRESS, process.env.DARE_TOKEN_ADDRESS],
  DEFAULT_TOKEN,
  'DARE_TOKEN_ADDRESS'
)

export const BASE_CHAIN_ID = 8453
export const DARE_DECIMALS = 18
export const BASESCAN_TX = 'https://basescan.org/tx/'

export const usingDefaultAddresses =
  STAKING_ADDRESS === DEFAULT_STAKING && DARE_TOKEN_ADDRESS === DEFAULT_TOKEN

// ─── ABIs ─────────────────────────────────────────────────────────────────────

export const STAKING_ABI = [
  { name: 'stake', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'exit', type: 'function', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
  { name: 'stakedBalance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'earned', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'isNodeAccount', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'totalStaked', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'paused', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'NODE_THRESHOLD', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // Declared so viem can decode the revert rather than showing a raw selector.
  { type: 'error', name: 'InsufficientAllowance', inputs: [] },
] as const

export const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const

// ─── Amount handling ──────────────────────────────────────────────────────────
// Hand-rolled rather than viem's parseUnits so the panel can reject bad input
// with a reason instead of throwing, and so a pasted "1,000,000" works.

export const WEI = 10n ** BigInt(DARE_DECIMALS)

export interface ParsedAmount {
  wei:   bigint
  error: string | null
}

/** Parses a user-typed $DARE amount into wei. Never throws. */
export function parseDare(input: string): ParsedAmount {
  const raw = input.trim().replace(/[, _]/g, '')
  if (!raw) return { wei: 0n, error: null }
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { wei: 0n, error: 'Numbers only' }

  const [whole, frac = ''] = raw.split('.')
  if (frac.length > DARE_DECIMALS) {
    return { wei: 0n, error: `At most ${DARE_DECIMALS} decimal places` }
  }

  const wei = BigInt(whole || '0') * WEI + BigInt((frac.padEnd(DARE_DECIMALS, '0')) || '0')
  if (wei <= 0n) return { wei: 0n, error: 'Enter an amount above zero' }
  return { wei, error: null }
}

/** Whole $DARE, floored — matches how the server assigns tiers. */
export function toWholeDare(wei: bigint): number {
  return Number(wei / WEI)
}

/** Display helper: full precision, grouped, trailing zeros trimmed. */
export function formatDare(wei: bigint, maxFractionDigits = 4): string {
  const whole = wei / WEI
  const frac  = wei % WEI
  const head  = whole.toLocaleString('en-US')
  if (frac === 0n || maxFractionDigits === 0) return head
  const tail = frac.toString().padStart(DARE_DECIMALS, '0').slice(0, maxFractionDigits).replace(/0+$/, '')
  return tail ? `${head}.${tail}` : head
}

// ─── Error surfacing ──────────────────────────────────────────────────────────
// Wallet and RPC errors are hostile to read. These are the ones this flow can
// actually produce, mapped to something a user can act on.

const REVERT_MESSAGES: Array<[RegExp, string]> = [
  [/InsufficientAllowance|0x13be252b/i, 'The staking contract is not approved to move that many $DARE yet. Approve first.'],
  [/Insufficient staked balance/i,      'That is more than you currently have staked.'],
  [/transfer amount exceeds balance|Insufficient balance|ERC20InsufficientBalance/i,
                                        'Your wallet does not hold that many $DARE.'],
  [/paused/i,                           'Staking is paused on the contract right now. Try again later.'],
  [/insufficient funds for gas|insufficient funds for intrinsic/i,
                                        'Not enough ETH on Base to pay gas for this transaction.'],
  [/user rejected|user denied|rejected the request|ACTION_REJECTED|4001/i,
                                        'Transaction rejected in your wallet.'],
  [/chain mismatch|unsupported chain|wrong network/i,
                                        'Your wallet is on the wrong network. Switch it to Base and retry.'],
  [/replacement transaction underpriced|nonce too low/i,
                                        'A previous transaction from this wallet is still pending. Wait for it to confirm, then retry.'],
]

export function humanizeTxError(err: unknown): string {
  const text = err instanceof Error
    ? `${err.message} ${(err as { details?: string }).details ?? ''} ${(err as { shortMessage?: string }).shortMessage ?? ''}`
    : String(err)

  for (const [pattern, message] of REVERT_MESSAGES) {
    if (pattern.test(text)) return message
  }

  // Fall back to the wallet's own short message when it has one — it is usually
  // more useful than the stack-laden `message`.
  const short = (err as { shortMessage?: string })?.shortMessage
  if (typeof short === 'string' && short.length > 0 && short.length < 160) return short
  return text.trim().slice(0, 160) || 'The transaction failed.'
}

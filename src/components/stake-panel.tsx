'use client'

// src/components/stake-panel.tsx
// Stake and unstake $DARE from the console, without leaving for a block explorer.
//
// Shape of the flow, and why it is shaped that way:
//
//  • Staking is TWO transactions. The contract pulls tokens with transferFrom
//    and reverts with InsufficientAllowance() when the ERC-20 allowance is
//    short, so an approval must be mined first. The token has no permit(), so
//    there is no single-signature shortcut available. The panel makes both steps
//    visible rather than surprising the user with a second wallet prompt.
//
//  • Approval is for the exact amount being staked, not unlimited. It costs a
//    little gas on every top-up, but leaving a standing unlimited allowance on a
//    staking contract is a real risk to push onto users by default.
//
//  • Unstaking is the direction that costs something, because access tracks the
//    stake: drop below the tier threshold and the API keys tied to that wallet
//    stop working (see lib/tiers.ts). Nothing prevents it — the contract has no
//    lock and we deliberately do not pretend otherwise — so the panel instead
//    computes the tier the user would land on BEFORE they sign, offers a
//    one-click amount that stops short of the threshold, and makes a
//    tier-breaking unstake require a deliberate second confirmation.
//
//    Since migration 007 that consequence is a suspension, not a revocation:
//    re-staking reactivates the same credential. The copy here says so, because
//    a user who believes their key is gone forever will rotate secrets they did
//    not need to rotate.
//
//    The panel used to warn that an unstake "ends your commitment early". It no
//    longer does, because there is no commitment: unstaking on day 1 and day 60
//    are byte-identical, and saying otherwise implied a term users were never
//    actually held to.
//
//  • "Unstake all" calls exit() rather than withdraw(balance): one transaction
//    instead of one-plus-dust, and it is the contract's only position-closing
//    path. There is no standalone reward-claim function on this contract, so the
//    panel never offers one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { encodeFunctionData }   from 'viem'
import {
  STAKING_ABI, ERC20_ABI, STAKING_ADDRESS, DARE_TOKEN_ADDRESS, BASE_CHAIN_ID,
  BASESCAN_TX, WEI, parseDare, formatDare, toWholeDare, humanizeTxError,
} from '@/lib/staking'
import { TIERS, tierForStake, rank, type TierName } from '@/lib/tiers'

interface Position {
  wallet:       string
  stakedWei:    string
  earnedWei:    string
  balanceWei:   string
  allowanceWei: string
  staked:       number
  balance:      number
  earned:       number
  isNode:       boolean
  paused:       boolean
}

interface Props {
  /** Wallet the server resolved the current tier from, if any. */
  preferredWallet: string | null
  /** Live (non-sandbox) keys at risk if the stake drops below the threshold. */
  liveKeyCount:    number
  /** Re-run the dashboard's tier verification once the chain has moved. */
  onSettled:       () => void | Promise<void>
}

type Mode = 'stake' | 'unstake'

/** One line in the progress readout, so a two-transaction flow is legible. */
interface Step {
  label:  string
  state:  'pending' | 'signing' | 'done' | 'failed'
  hash?:  string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const CAIP_BASE = `eip155:${BASE_CHAIN_ID}`

export function StakePanel({ preferredWallet, liveKeyCount, onSettled }: Props) {
  const { getAccessToken } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [mode,     setMode]     = useState<Mode>('stake')
  const [amount,   setAmount]   = useState('')
  const [steps,    setSteps]    = useState<Step[]>([])
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [notice,   setNotice]   = useState<string | null>(null)
  const [ackBreak, setAckBreak] = useState(false)

  // Guards against a slow position fetch landing after the component unmounts or
  // after the user has switched wallets.
  const requestSeq = useRef(0)

  const wallet = useMemo(
    () => wallets.find(w => w.address.toLowerCase() === walletAddress?.toLowerCase()) ?? null,
    [wallets, walletAddress]
  )

  // Default to the wallet the server already found the stake on; otherwise the
  // first connected one. Picking blind would show a Google user their empty
  // embedded wallet while their MetaMask position sits elsewhere.
  useEffect(() => {
    if (walletAddress || !walletsReady || wallets.length === 0) return
    const match = preferredWallet
      ? wallets.find(w => w.address.toLowerCase() === preferredWallet.toLowerCase())
      : undefined
    setWalletAddress((match ?? wallets[0]).address)
  }, [walletsReady, wallets, preferredWallet, walletAddress])

  const loadPosition = useCallback(async (address: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/stake/position?wallet=${address}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (seq !== requestSeq.current) return
      if (!res.ok) { setError(data.error ?? 'Could not read your position'); setPosition(null); return }
      setPosition(data)
      setError(null)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err instanceof Error ? err.message : 'Could not read your position')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [getAccessToken])

  useEffect(() => { if (walletAddress) loadPosition(walletAddress) }, [walletAddress, loadPosition])

  // ── Derived figures ───────────────────────────────────────────────────────
  const stakedWei    = BigInt(position?.stakedWei    ?? '0')
  const balanceWei   = BigInt(position?.balanceWei   ?? '0')
  const allowanceWei = BigInt(position?.allowanceWei ?? '0')
  const earnedWei    = BigInt(position?.earnedWei    ?? '0')

  const parsed  = parseDare(amount)
  const amountWei = parsed.wei
  const stakedNow = toWholeDare(stakedWei)
  const tierNow: TierName = tierForStake(stakedNow)

  const stakedAfter = mode === 'stake'
    ? toWholeDare(stakedWei + amountWei)
    : toWholeDare(amountWei > stakedWei ? 0n : stakedWei - amountWei)
  const tierAfter: TierName = tierForStake(stakedAfter)

  const tierChanges = tierAfter !== tierNow
  const tierDrops   = rank(tierAfter) < rank(tierNow)
  /** A drop only costs keys if there were paid keys to lose. */
  const breaksAccess = mode === 'unstake' && tierDrops && liveKeyCount > 0

  const needsApproval = mode === 'stake' && amountWei > 0n && allowanceWei < amountWei
  const isFullExit    = mode === 'unstake' && amountWei > 0n && amountWei >= stakedWei

  // The largest withdrawal that still clears the current tier's threshold.
  // Offering only MAX meant the one-click path was always the one that costs you
  // your tier; most accidental breaks are just this button not existing.
  const safeMaxWei = (() => {
    if (tierNow === 'scout') return 0n
    const floor = BigInt(TIERS[tierNow].stake) * WEI
    return stakedWei > floor ? stakedWei - floor : 0n
  })()

  // ── Validation ────────────────────────────────────────────────────────────
  const validation = (() => {
    if (parsed.error) return parsed.error
    if (amountWei === 0n) return null
    if (mode === 'stake') {
      if (position?.paused)        return 'Staking is paused on the contract right now.'
      if (amountWei > balanceWei)  return `You hold ${formatDare(balanceWei)} $DARE.`
    } else {
      if (stakedWei === 0n)        return 'You have nothing staked from this wallet.'
      if (amountWei > stakedWei)   return `You have ${formatDare(stakedWei)} $DARE staked.`
    }
    return null
  })()

  const canSubmit =
    !busy && !loading && !!wallet && amountWei > 0n && !validation &&
    (!breaksAccess || ackBreak)

  // Re-arming the confirmation on every edit is deliberate: an acknowledgement
  // should apply to the number the user actually read.
  useEffect(() => { setAckBreak(false) }, [amount, mode])

  // ── Transaction plumbing ──────────────────────────────────────────────────

  const pushStep = (step: Step) => setSteps(s => [...s, step])
  const patchLast = (patch: Partial<Step>) =>
    setSteps(s => s.map((st, i) => (i === s.length - 1 ? { ...st, ...patch } : st)))

  /** Polls our own receipt route until the transaction settles. */
  const waitForReceipt = useCallback(async (hash: string) => {
    const deadline = Date.now() + 4 * 60 * 1000
    while (Date.now() < deadline) {
      await sleep(2500)
      const token = await getAccessToken()
      const res = await fetch(`/api/stake/receipt?hash=${hash}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) continue
      const data = await res.json()
      if (data.status === 'success')  return
      if (data.status === 'reverted') throw new Error('The transaction reverted on-chain.')
    }
    throw new Error('Timed out waiting for confirmation. The transaction may still land — check Basescan.')
  }, [getAccessToken])

  /** Signs and broadcasts one call, then blocks until it is mined. */
  const sendTx = useCallback(async (label: string, to: `0x${string}`, data: `0x${string}`) => {
    if (!wallet) throw new Error('No wallet connected')

    pushStep({ label, state: 'signing' })

    // The wallet must be on Base or the transaction goes to the wrong chain
    // entirely. Privy exposes chainId in CAIP-2 form.
    if (wallet.chainId !== CAIP_BASE) {
      await wallet.switchChain(BASE_CHAIN_ID)
    }

    const provider = await wallet.getEthereumProvider()
    const hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: wallet.address, to, data }],
    }) as string

    patchLast({ state: 'pending', hash })
    await waitForReceipt(hash)
    patchLast({ state: 'done', hash })
    return hash
  }, [wallet, waitForReceipt])

  async function run() {
    if (!canSubmit || !wallet) return
    setBusy(true); setError(null); setNotice(null); setSteps([])

    try {
      if (mode === 'stake') {
        if (allowanceWei < amountWei) {
          await sendTx(
            `Approve ${formatDare(amountWei)} $DARE`,
            DARE_TOKEN_ADDRESS,
            encodeFunctionData({
              abi: ERC20_ABI, functionName: 'approve', args: [STAKING_ADDRESS, amountWei],
            })
          )
        }
        await sendTx(
          `Stake ${formatDare(amountWei)} $DARE`,
          STAKING_ADDRESS,
          encodeFunctionData({ abi: STAKING_ABI, functionName: 'stake', args: [amountWei] })
        )
        setNotice(
          tierAfter !== tierNow
            ? `Staked. You are now ${TIERS[tierAfter].label} — generate a key below to use it.`
            : 'Staked.'
        )
      } else {
        await sendTx(
          isFullExit ? 'Unstake everything' : `Unstake ${formatDare(amountWei)} $DARE`,
          STAKING_ADDRESS,
          isFullExit
            ? encodeFunctionData({ abi: STAKING_ABI, functionName: 'exit' })
            : encodeFunctionData({ abi: STAKING_ABI, functionName: 'withdraw', args: [amountWei] })
        )
        setNotice(
          breaksAccess
            ? `Unstaked. Your stake no longer meets ${TIERS[tierNow].label}, so live keys on this wallet are suspended until you re-stake.`
            : 'Unstaked.'
        )
      }

      setAmount('')
      await loadPosition(wallet.address)
      // The dashboard caches the verified tier for five minutes; the chain has
      // just moved, so force it to re-read rather than showing a stale tier.
      await onSettled()
    } catch (err) {
      patchLast({ state: 'failed' })
      setError(humanizeTxError(err))
    } finally {
      setBusy(false)
    }
  }

  // ── Quick amounts ─────────────────────────────────────────────────────────
  // "What do I still need for the next tier" is the question this panel exists
  // to answer, so offer it as one click rather than making people subtract.
  const topUps = (['analyst', 'oracle'] as const)
    .map(name => ({ name, short: BigInt(TIERS[name].stake) * WEI - stakedWei }))
    .filter(t => t.short > 0n && t.short <= balanceWei)

  if (!walletsReady) return null

  if (wallets.length === 0) {
    return (
      <div className="panel p-5 space-y-2">
        <div className="flex items-center gap-2.5">
          <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
          <span className="legend">NO WALLET CONNECTED</span>
        </div>
        <p className="text-[12px] text-[color:var(--text-dim)]">
          Connect a wallet to stake $DARE. Signing in with Google or email
          provisions one for you automatically.
        </p>
      </div>
    )
  }

  const tierColor = (t: TierName) =>
    t === 'oracle' ? 'text-emerald-400' : t === 'analyst' ? 'text-[color:var(--blue-bright)]' : 'text-amber-400'

  return (
    <div className="space-y-4">
      {/* ── Wallet selector ───────────────────────────────────────────────── */}
      {wallets.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="legend">STAKE FROM</span>
          {wallets.map(w => {
            const on = w.address.toLowerCase() === walletAddress?.toLowerCase()
            return (
              <button
                key={w.address}
                onClick={() => { setWalletAddress(w.address); setSteps([]); setNotice(null) }}
                disabled={busy}
                className={`mono text-[11px] rounded-md px-3 py-1.5 border transition-colors disabled:opacity-40 ${
                  on
                    ? 'border-[color:var(--blue-bright)] text-white bg-[color:var(--blue-deep)]'
                    : 'border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)]'
                }`}
              >
                {w.address.slice(0, 6)}…{w.address.slice(-4)}
                <span className="text-[color:var(--text-faint)] ml-1.5">{w.walletClientType}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Position ──────────────────────────────────────────────────────── */}
      <div className="panel grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[color:var(--edge)]">
        <div className="px-5 py-4 space-y-1.5">
          <div className="legend">WALLET BALANCE</div>
          <div className="mono text-[17px] text-white tabular-nums">
            {loading ? '—' : formatDare(balanceWei, 2)}
            <span className="text-[11px] text-[color:var(--text-faint)] ml-1.5">$DARE</span>
          </div>
        </div>
        <div className="px-5 py-4 space-y-1.5">
          <div className="legend">STAKED HERE</div>
          <div className="mono text-[17px] text-white tabular-nums">
            {loading ? '—' : formatDare(stakedWei, 2)}
            <span className="text-[11px] text-[color:var(--text-faint)] ml-1.5">$DARE</span>
          </div>
        </div>
        <div className="px-5 py-4 space-y-1.5">
          <div className="legend">REWARDS ACCRUED</div>
          <div className="mono text-[17px] text-white tabular-nums">
            {loading ? '—' : formatDare(earnedWei, 2)}
            <span className="text-[11px] text-[color:var(--text-faint)] ml-1.5">$DARE</span>
          </div>
        </div>
      </div>

      {/* ── Mode ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {(['stake', 'unstake'] as const).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); setAmount(''); setSteps([]); setError(null); setNotice(null) }}
            disabled={busy}
            className={`mono text-[11px] tracking-[0.14em] uppercase rounded-md px-4 py-2 border transition-colors disabled:opacity-40 ${
              mode === m
                ? 'border-[color:var(--blue-bright)] text-white bg-[color:var(--blue-deep)]'
                : 'border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)]'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="panel p-5 space-y-4">
        {/* ── Amount ──────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <label className="legend block" htmlFor="stake-amount">
            AMOUNT TO {mode.toUpperCase()}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="stake-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={busy || loading}
              className="mono flex-1 min-w-0 bg-[#05070a] border border-[color:var(--edge)] rounded-md px-3 py-2.5 text-[15px] text-white tabular-nums placeholder:text-[color:var(--text-faint)] focus:outline-none focus:border-[color:var(--blue-bright)] disabled:opacity-50"
            />
            <button
              onClick={() => setAmount(formatDare(mode === 'stake' ? balanceWei : stakedWei, 18).replace(/,/g, ''))}
              disabled={busy || loading}
              className="btn-ghost rounded-md px-3 py-2.5 text-[11px] mono disabled:opacity-40"
            >
              MAX
            </button>
          </div>

          {mode === 'unstake' && safeMaxWei > 0n && !busy && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => setAmount(formatDare(safeMaxWei, 18).replace(/,/g, ''))}
                className="mono text-[11px] rounded-md px-3 py-1.5 border border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)] hover:text-white transition-colors"
              >
                − {formatDare(safeMaxWei, 0)} → keep {TIERS[tierNow].label}
              </button>
            </div>
          )}

          {mode === 'stake' && topUps.length > 0 && !busy && (
            <div className="flex flex-wrap gap-2 pt-1">
              {topUps.map(t => (
                <button
                  key={t.name}
                  onClick={() => setAmount(formatDare(t.short, 18).replace(/,/g, ''))}
                  className="mono text-[11px] rounded-md px-3 py-1.5 border border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)] hover:text-white transition-colors"
                >
                  + {formatDare(t.short, 0)} → {TIERS[t.name].label}
                </button>
              ))}
            </div>
          )}

          {validation && (
            <p className="text-[11px] text-amber-400">{validation}</p>
          )}
        </div>

        {/* ── Preview ─────────────────────────────────────────────────────── */}
        {amountWei > 0n && !validation && (
          <div className="border-t border-[color:var(--edge)] pt-4 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
              <span className="legend">AFTER</span>
              <span className="mono text-white tabular-nums">
                {stakedAfter.toLocaleString()} $DARE staked
              </span>
              <span className="text-[color:var(--text-faint)]">·</span>
              <span className={`mono ${tierColor(tierAfter)}`}>
                {TIERS[tierAfter].label.toUpperCase()}
              </span>
              {tierChanges && (
                <span className="mono text-[11px] text-[color:var(--text-faint)]">
                  (from {TIERS[tierNow].label})
                </span>
              )}
            </div>

            {mode === 'stake' && needsApproval && (
              <p className="text-[11px] text-[color:var(--text-faint)]">
                Two transactions: an approval for exactly {formatDare(amountWei)} $DARE,
                then the stake itself. Both need gas in ETH on Base.
              </p>
            )}

            {mode === 'unstake' && isFullExit && (
              <p className="text-[11px] text-[color:var(--text-faint)]">
                Closes your whole position in one transaction via <span className="mono">exit()</span>.
              </p>
            )}

            {mode === 'stake' && tierChanges && (
              <p className="text-[11px] text-[color:var(--text-faint)]">
                {TIERS[tierAfter].stake > 0
                  ? `No lock-up — you can withdraw whenever you like. Access continues while you hold at least ${TIERS[tierAfter].stake.toLocaleString()} $DARE; below that, live keys are suspended until you re-stake.`
                  : 'Free tier — no stake to maintain.'}
              </p>
            )}
          </div>
        )}

        {/* ── Tier-breaking unstake ───────────────────────────────────────── */}
        {breaksAccess && !validation && amountWei > 0n && (
          <div className="panel border-red-900/60 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="led bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
              <span className="mono text-[10px] tracking-[0.14em] text-red-400">
                THIS SUSPENDS API ACCESS
              </span>
            </div>
            <p className="text-[12px] leading-relaxed text-red-200">
              Unstaking this much drops you from {TIERS[tierNow].label} to {TIERS[tierAfter].label}.
              {' '}{liveKeyCount} live {liveKeyCount === 1 ? 'key' : 'keys'} on this wallet stop
              working immediately — anything in production using {liveKeyCount === 1 ? 'it' : 'them'}
              {' '}starts failing with 403.
            </p>
            <p className="text-[11px] leading-relaxed text-[color:var(--text-dim)]">
              Suspension is reversible: re-staking to {TIERS[tierNow].stake.toLocaleString()} $DARE
              reactivates the same keys. You will not have to issue or redeploy a new one.
            </p>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={ackBreak}
                onChange={e => setAckBreak(e.target.checked)}
                className="mt-0.5 accent-red-500"
              />
              <span className="text-[12px] text-red-200">
                I understand my live keys stop working until I re-stake.
              </span>
            </label>
          </div>
        )}

        {/* ── Submit ──────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={!canSubmit}
            className={`rounded-md px-4 py-2 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed ${
              mode === 'unstake' && breaksAccess
                ? 'btn-ghost border-red-900/70 text-red-300 hover:border-red-700 hover:text-red-200'
                : 'btn-primary'
            }`}
          >
            {busy
              ? 'Confirm in your wallet…'
              : mode === 'stake'
                ? (needsApproval ? 'Approve & stake' : 'Stake')
                : (isFullExit ? 'Unstake everything' : 'Unstake')}
          </button>

          {position?.paused && mode === 'stake' && (
            <span className="mono text-[11px] text-amber-400">CONTRACT PAUSED</span>
          )}

          <span className="flex-1" />

          <button
            onClick={() => walletAddress && loadPosition(walletAddress)}
            disabled={busy || loading}
            className="mono text-[11px] text-[color:var(--text-faint)] hover:text-white transition-colors disabled:opacity-40"
          >
            {loading ? 'READING CHAIN…' : 'REFRESH'}
          </button>
        </div>

        {/* ── Progress ────────────────────────────────────────────────────── */}
        {steps.length > 0 && (
          <div className="border-t border-[color:var(--edge)] pt-4 space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className={`led ${
                  s.state === 'done'   ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]' :
                  s.state === 'failed' ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]' :
                  'bg-[color:var(--blue-bright)] led-pulse'
                }`} />
                <span className="mono text-[11px] text-[color:var(--text-dim)]">{s.label}</span>
                <span className="mono text-[10px] text-[color:var(--text-faint)]">
                  {s.state === 'signing' ? 'AWAITING SIGNATURE'
                    : s.state === 'pending' ? 'CONFIRMING'
                    : s.state === 'done' ? 'CONFIRMED' : 'FAILED'}
                </span>
                {s.hash && (
                  <a
                    href={`${BASESCAN_TX}${s.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono text-[10px] text-[color:var(--blue-bright)] hover:underline"
                  >
                    {s.hash.slice(0, 10)}…
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2.5">
            <span className="led bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] mt-1" />
            <span className="text-[12px] text-red-300">{error}</span>
          </div>
        )}

        {notice && !error && (
          <div className="flex items-start gap-2.5">
            <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)] mt-1" />
            <span className="text-[12px] text-emerald-300">{notice}</span>
          </div>
        )}
      </div>

      <p className="text-[11px] text-[color:var(--text-faint)] px-1">
        Staking contract{' '}
        <a
          href={`https://basescan.org/address/${STAKING_ADDRESS}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mono text-[color:var(--text-dim)] hover:text-[color:var(--blue-bright)]"
        >
          {STAKING_ADDRESS.slice(0, 10)}…{STAKING_ADDRESS.slice(-6)}
        </a>{' '}
        on Base. This contract has no standalone reward-claim function — rewards
        settle when a position is closed with <span className="mono">exit()</span>.
      </p>
    </div>
  )
}

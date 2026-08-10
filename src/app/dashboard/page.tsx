'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { SPORTS } from '@/lib/capabilities'
import { TIERS } from '@/lib/tiers'
import { StakePanel } from '@/components/stake-panel'

// See page.tsx: the old hardcoded `sports-oracle.vercel.app` serves an unrelated
// app. Prefer the configured public URL, fall back to the real production alias.
const _envUrl = process.env.NEXT_PUBLIC_APP_URL
const PROD_URL = _envUrl && _envUrl.startsWith('https://') && !_envUrl.includes('localhost')
  ? _envUrl.replace(/\/$/, '')
  : 'https://router.sonara.bio'

// Derived from lib/tiers.ts so the console can't display a threshold the gateway
// doesn't enforce.
const TIER_META: Record<string, { label: string; next?: string; nextStake?: string; color: string }> = {
  none: {
    label: 'NO KEY', next: TIERS.scout.label, nextStake: 'free',
    color: 'text-[color:var(--text-faint)]',
  },
  scout: {
    label: 'SCOUT · SANDBOX',
    next: TIERS.analyst.label, nextStake: TIERS.analyst.stake.toLocaleString(),
    color: 'text-amber-400',
  },
  analyst: {
    label: 'ANALYST',
    next: TIERS.oracle.label, nextStake: TIERS.oracle.stake.toLocaleString(),
    color: 'text-[color:var(--blue-bright)]',
  },
  oracle: { label: 'ORACLE · NODE', color: 'text-emerald-400' },
}

interface StakeStatus {
  tier:        string
  tierLabel?:  string
  stakeAmount: number
  earned?:     number
  sportMask:   string[]
  wallet:      string | null
  wallets?:    Array<{ address: string; staked: number }> | string[]
  warning?:    string
  lockedUntil?: string | null
  sandbox?:    boolean
  rewards?:    boolean
  rpm?:        number
}

interface ApiKey {
  id:           string
  key_prefix:   string
  tier:         string
  sport_mask:   string[]
  is_active:    boolean
  is_sandbox:   boolean
  last_used_at: string | null
  created_at:   string
  revoked_at:   string | null
  /** Set when a stake breach suspended the key. Cleared by re-staking. */
  suspended_at:   string | null
  suspend_reason: string | null
}

function Panel({ legend, title, children, action }: {
  legend: string; title: string; children: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="legend">{legend}</span>
        <span className="h-px flex-1 bg-[color:var(--edge)]" />
        {action}
      </div>
      <h2 className="display text-[18px] text-white">{title}</h2>
      {children}
    </section>
  )
}

function DashboardInner() {
  const { authenticated, ready, getAccessToken, logout, login } = usePrivy()
  const params = useSearchParams()

  const [stake,     setStake]     = useState<StakeStatus | null>(null)
  const [keys,      setKeys]      = useState<ApiKey[]>([])
  const [newKey,    setNewKey]    = useState<string | null>(null)
  const [selected,  setSelected]  = useState<string[]>([])
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [copied,    setCopied]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Arriving from a sport card on the landing page pre-selects that sport.
  useEffect(() => {
    const s = params.get('sport')
    if (s && SPORTS.some(x => x.key === s)) setSelected([s])
  }, [params])

  // Deliberately no redirect for signed-out visitors. Bouncing them to the
  // landing page is how a new user ended up in a loop: the CTA sent them here,
  // this sent them back, and nothing ever offered a sign-in.

  // `refresh` bypasses the server's five-minute tier cache. It is set only after
  // a stake or unstake transaction confirms, where the cached tier is known to be
  // stale and showing it would look like the transaction did nothing.
  //
  // `silent` keeps the page mounted while that happens. Without it the whole
  // dashboard swaps to the loading state, which remounts the stake panel and
  // throws away the confirmation the user just earned — transaction hashes,
  // Basescan links and all.
  const load = useCallback(async (
    { refresh = false, silent = false }: { refresh?: boolean; silent?: boolean } = {}
  ) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const token = await getAccessToken()

      // Keys don't depend on a wallet, so load them regardless.
      const keysRes = await fetch('/api/auth/keys', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (keysRes.ok) setKeys((await keysRes.json()).keys ?? [])

      // No wallet is sent: the server reads the account's linked wallets from
      // Privy and checks every one, so a Google user who staked from MetaMask
      // resolves correctly without the client having to guess which to use.
      const res = await fetch('/api/auth/verify-stake', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refresh }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not verify stake'); return }
      setStake(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [getAccessToken])

  useEffect(() => { if (authenticated) load() }, [authenticated, load])

  async function generate() {
    setBusy(true); setError(null); setNewKey(null); setCopied(false)
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/auth/keys/create', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sportMask: selected }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not generate key'); return }
      setNewKey(data.key)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate key')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    const token = await getAccessToken()
    const res = await fetch('/api/auth/keys/revoke', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ keyId: id }),
    })
    if (res.ok) {
      setKeys(k => k.map(x => x.id === id ? { ...x, is_active: false, revoked_at: new Date().toISOString() } : x))
    }
  }

  async function copyKey() {
    if (!newKey) return
    try {
      await navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the key stays selectable by hand */ }
  }

  if (ready && !authenticated) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-24">
        <div className="panel p-8 space-y-5 max-w-md">
          <div className="flex items-center gap-2.5">
            <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
            <span className="legend">NOT SIGNED IN</span>
          </div>
          <h1 className="display text-[22px] text-white">Sign in to mint a key</h1>
          <p className="text-[13px] leading-relaxed text-[color:var(--text-dim)]">
            Continue with Google, email, or a wallet. Scout is free and needs no
            stake — you can have a working sandbox key in under a minute.
          </p>
          <button onClick={login} className="btn-primary rounded-md px-5 py-2.5 text-[13px]">
            Continue
          </button>
          <p className="text-[11px] text-[color:var(--text-faint)]">
            Signing in with Google or email provisions a wallet for you
            automatically. You can also connect MetaMask.
          </p>
        </div>
      </main>
    )
  }

  if (!ready || loading) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-20">
        <div className="flex items-center gap-3">
          <span className="led bg-[color:var(--blue-bright)] led-pulse" />
          <span className="mono text-[12px] text-[color:var(--text-dim)]">Loading…</span>
        </div>
      </main>
    )
  }

  const tier = stake?.tier ?? 'none'
  const tm   = TIER_META[tier] ?? TIER_META.none
  const staked = tier !== 'none'
  const picksAll = tier === 'analyst' || tier === 'oracle'
  const activeKeys = keys.filter(k => k.is_active)
  // Only paid keys are at risk when a stake drops — sandbox keys carry no stake
  // requirement and survive, so counting them would overstate the warning. Keys
  // already suspended are excluded too: they have nothing left to lose.
  const liveKeys = activeKeys.filter(k => !k.is_sandbox && !k.suspended_at)

  return (
    <>
      <header className="border-b border-[color:var(--edge)] sticky top-0 z-30 backdrop-blur-md bg-black/70">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className={`led ${staked ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)] led-pulse' : 'bg-amber-400'}`} />
            <span className="display text-[15px] tracking-tight text-white">SPORTS ORACLE</span>
          </Link>
          <span className="mono text-[10px] tracking-[0.16em] text-[color:var(--text-faint)] hidden sm:inline">
            CONSOLE
          </span>
          <span className="flex-1" />
          <Link href="/" className="btn-ghost rounded-md px-3 py-1.5 text-[12px]">
            Main site
          </Link>
          <button
            onClick={() => { logout(); window.location.href = '/' }}
            className="btn-ghost rounded-md px-3 py-1.5 text-[12px]"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 space-y-14">
        {error && (
          <div className="panel border-red-900/60 p-4 flex items-start gap-3">
            <span className="led bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] mt-1" />
            <span className="text-[12px] text-red-300">{error}</span>
          </div>
        )}

        {/* ── Stake ─────────────────────────────────────────────────────── */}
        <Panel legend="ACCOUNT" title="Stake status">
          <div className="panel grid sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[color:var(--edge)]">
            <div className="px-5 py-4 space-y-1.5">
              <div className="legend">TIER</div>
              <div className={`mono text-[18px] ${tm.color}`}>{tm.label}</div>
            </div>
            <div className="px-5 py-4 space-y-1.5">
              <div className="legend">STAKED</div>
              <div className="mono text-[18px] text-white tabular-nums">
                {(stake?.stakeAmount ?? 0).toLocaleString()}
                <span className="text-[11px] text-[color:var(--text-faint)] ml-1.5">$DARE</span>
              </div>
            </div>
            <div className="px-5 py-4 space-y-1.5">
              <div className="legend">SPORTS UNLOCKED</div>
              <div className="mono text-[18px] text-white tabular-nums">
                {stake?.sportMask.length ?? 0}
                <span className="text-[11px] text-[color:var(--text-faint)] ml-1.5">
                  / {SPORTS.filter(s => s.entitled).length}
                </span>
              </div>
            </div>
            <div className="px-5 py-4 space-y-1.5">
              <div className="legend">ACTIVE KEYS</div>
              <div className="mono text-[18px] text-white tabular-nums">{activeKeys.length}</div>
            </div>
          </div>

          {stake?.wallet && (
            <div className="flex items-center gap-2 px-1">
              <span className="legend">WALLET</span>
              <code className="mono text-[11px] text-[color:var(--text-dim)] break-all">{stake.wallet}</code>
            </div>
          )}

          {/* Scout needs no stake, so an unstaked visitor is not blocked — they
              are one click from a working sandbox key. */}
          {!staked && (
            <div className="panel p-4 flex flex-wrap items-center gap-3">
              <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
              <span className="text-[12px] text-[color:var(--text-dim)]">
                Scout is free — mint a sandbox key now and build against
                production-identical shapes. Stake {TIERS.analyst.stake.toLocaleString()} $DARE to
                switch the same integration to live data.
              </span>
            </div>
          )}

          {tm.next && (
            <p className="text-[11px] text-[color:var(--text-faint)] px-1">
              {tier === 'scout' || tier === 'none'
                ? `Stake ${tm.nextStake} $DARE to reach ${tm.next} and unlock live data.`
                : `Stake ${tm.nextStake} $DARE to reach ${tm.next} — adds priority limits and reward eligibility.`}
            </p>
          )}

          {/* Replaces a "commitment active until <date>" line. There is no
              commitment: the contract has no lock and nothing off-chain enforces
              a term, so the only true statement is that access tracks the stake. */}
          {staked && (
            <p className="text-[11px] text-[color:var(--text-faint)] px-1">
              No lock-up — you can unstake at any time. Access continues for as long
              as you hold at least{' '}
              <span className="mono text-white">
                {(TIERS[tier as keyof typeof TIERS]?.stake ?? 0).toLocaleString()}
              </span>{' '}
              $DARE; drop below that and live keys are suspended until you re-stake.
            </p>
          )}
        </Panel>

        {/* ── Stake / unstake ───────────────────────────────────────────── */}
        <Panel legend="POSITION" title="Stake or unstake $DARE">
          <StakePanel
            preferredWallet={stake?.wallet ?? null}
            liveKeyCount={liveKeys.length}
            onSettled={() => load({ refresh: true, silent: true })}
          />
        </Panel>

        {/* ── Generate ──────────────────────────────────────────────────── */}
        {staked && (
          <Panel legend="PROVISION" title="Generate a key">
            {picksAll ? (
              <p className="text-[12px] text-[color:var(--text-dim)]">
                Your tier includes every available sport automatically.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-[12px] text-[color:var(--text-dim)]">
                  Select the sports this key may access.
                </p>
                <div className="flex flex-wrap gap-2">
                  {(stake?.sportMask ?? []).map(s => {
                    const on = selected.includes(s)
                    return (
                      <button
                        key={s}
                        onClick={() => setSelected(p => on ? p.filter(x => x !== s) : [...p, s])}
                        className={`mono text-[11px] rounded-md px-3 py-1.5 border transition-colors ${
                          on
                            ? 'border-[color:var(--blue-bright)] text-white bg-[color:var(--blue-deep)]'
                            : 'border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)]'
                        }`}
                      >
                        {on ? '● ' : '○ '}{s}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <button
              onClick={generate}
              disabled={busy || (!picksAll && selected.length === 0)}
              className="btn-primary rounded-md px-4 py-2 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Generating…' : 'Generate key'}
            </button>

            {newKey && (
              <div className="panel border-amber-700/70 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
                  <span className="mono text-[10px] tracking-[0.14em] text-amber-400">
                    SHOWN ONCE — COPY IT NOW
                  </span>
                </div>
                <code className="mono block text-[13px] text-white break-all select-all bg-[#05070a] border border-[color:var(--edge)] rounded p-3">
                  {newKey}
                </code>
                <div className="flex items-center gap-3">
                  <button onClick={copyKey} className="btn-primary rounded-md px-3 py-1.5 text-[12px]">
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <span className="text-[11px] text-[color:var(--text-faint)]">
                    It is stored hashed and cannot be retrieved again.
                  </span>
                </div>
              </div>
            )}
          </Panel>
        )}

        {/* ── Keys ──────────────────────────────────────────────────────── */}
        <Panel
          legend="CREDENTIALS"
          title="Your keys"
          action={
            <span className="mono text-[10px] text-[color:var(--text-faint)]">
              {activeKeys.length} ACTIVE / {keys.length} TOTAL
            </span>
          }
        >
          {keys.length === 0 ? (
            <div className="panel p-6 text-center">
              <p className="text-[12px] text-[color:var(--text-dim)]">
                No keys yet.{staked ? ' Generate one above.' : ' Stake $DARE above to mint your first key.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map(k => {
                // Three states, not two: suspended keys are alive and recoverable
                // by re-staking, so showing them as revoked would tell the user to
                // rotate a credential that is about to start working again.
                const isSuspended = k.is_active && !!k.suspended_at
                return (
                <div key={k.id} className={`panel px-4 py-3.5 flex flex-wrap items-center gap-x-5 gap-y-2 ${k.is_active ? '' : 'opacity-50'}`}>
                  <span className={`led ${
                    !k.is_active ? 'bg-red-500'
                    : isSuspended ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]'
                    : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]'
                  }`} />
                  <code className="mono text-[12px] text-white">{k.key_prefix}…</code>
                  <span className={`mono text-[10px] tracking-[0.14em] ${
                    k.tier === 'oracle' ? 'text-[color:var(--blue-bright)]' :
                    k.tier === 'analyst' ? 'text-[color:var(--blue-bright)]' : 'text-emerald-400'
                  }`}>
                    {k.tier.toUpperCase()}
                  </span>
                  <span className="mono text-[11px] text-[color:var(--text-faint)] truncate max-w-[220px]">
                    {k.sport_mask.join(' · ')}
                  </span>
                  <span className="flex-1" />
                  <span className="mono text-[10px] text-[color:var(--text-faint)]">
                    {k.last_used_at
                      ? `USED ${new Date(k.last_used_at).toLocaleDateString()}`
                      : 'NEVER USED'}
                  </span>
                  {k.is_active ? (
                    <button
                      onClick={() => revoke(k.id)}
                      className="mono text-[11px] text-red-400 hover:text-red-300 transition-colors"
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="mono text-[10px] text-red-500">REVOKED</span>
                  )}

                  {isSuspended && (
                    <div className="w-full flex items-start gap-2 pt-1">
                      <span className="mono text-[10px] tracking-[0.14em] text-amber-400 shrink-0">
                        SUSPENDED
                      </span>
                      <span className="text-[11px] text-[color:var(--text-dim)]">
                        {k.suspend_reason ?? 'Stake fell below the tier threshold.'}
                        {' '}Re-stake above to reactivate this same key — you do not need to
                        generate a new one.
                      </span>
                    </div>
                  )}
                </div>
              )})}
            </div>
          )}
        </Panel>

        {/* ── Quick start ───────────────────────────────────────────────── */}
        <Panel legend="NEXT" title="Use your key">
          <pre className="code p-4 text-[color:var(--text-dim)]">{`curl -H "X-Oracle-Key: sk_live_..." \\
  "${PROD_URL}/api/v1/nba/injuries"`}</pre>
          <Link href="/#sports" className="btn-ghost inline-block rounded-md px-4 py-2 text-[12px]">
            Browse all endpoints
          </Link>
        </Panel>
      </main>
    </>
  )
}

export default function Dashboard() {
  // useSearchParams needs a Suspense boundary to avoid opting the whole route
  // into client-side-only rendering.
  return (
    <Suspense fallback={
      <main className="max-w-5xl mx-auto px-6 py-20">
        <span className="mono text-[12px] text-[color:var(--text-dim)]">Loading…</span>
      </main>
    }>
      <DashboardInner />
    </Suspense>
  )
}

'use client'

import { useState } from 'react'

// $DARE — Agent Daredevil. Single source of truth for the token facts shown here.
// Contract is the ONLY address a buyer should ever trust; it is repeated in the
// copy control and every outbound link so the two cannot drift.
const DARE = {
  symbol:   'DARE',
  name:     'Agent Daredevil',
  decimals: 18,
  contract: '0x07321eAe7b7018A241c97C3E31f072098C3D5bc6',
  chain:    'Base Mainnet',
  chainId:  8453,
  coingecko: 'https://www.coingecko.com/en/coins/agent-daredevil',
  basescan:  'https://basescan.org/token/0x07321eAe7b7018A241c97C3E31f072098C3D5bc6',
  // Uniswap, pre-filled to swap into $DARE on Base.
  uniswap:   'https://app.uniswap.org/swap?chain=base&outputCurrency=0x07321eAe7b7018A241c97C3E31f072098C3D5bc6',
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

interface Eth {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>
}
function getEth(): Eth | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { ethereum?: Eth }).ethereum ?? null
}

// ─── Purchase steps ───────────────────────────────────────────────────────────
// Two routes, because the right one depends on what the buyer already has open.
// Uniswap is the canonical DEX; MetaMask's built-in Swap is the fewest-clicks
// path for someone already in the extension. Both end at the same place.

const UNISWAP_STEPS: [string, string][] = [
  ['Fund a wallet with ETH on Base',
    'You need ETH on the Base network — a small amount for gas plus whatever you plan to swap. Bridge from Ethereum at bridge.base.org, or buy ETH directly on Base in MetaMask.'],
  ['Open Uniswap and connect',
    'Use the “Buy on Uniswap” button below. Connect your wallet and make sure the network selector reads Base.'],
  ['Verify the $DARE contract',
    `The link pre-selects $DARE as the output token — confirm the address shows ${short(DARE.contract)}. Only ever trust this exact contract; imposters reuse the name.`],
  ['Enter an amount and swap',
    'Set how much ETH to spend. Review the rate and slippage, then press Swap.'],
  ['Confirm in your wallet',
    'Approve the transaction in MetaMask and wait for it to confirm on Base — usually a few seconds.'],
  ['Add $DARE to your wallet',
    'Use “Add to MetaMask” below so your balance is visible. You’re ready to stake on the dashboard.'],
]

const METAMASK_STEPS: [string, string][] = [
  ['Switch MetaMask to Base',
    'Open MetaMask and select the Base network from the network dropdown. Add it via chainlist.org if it isn’t listed yet.'],
  ['Hold ETH on Base',
    'Fund the wallet with ETH on Base to cover the swap amount and gas.'],
  ['Open Swap',
    'Tap the Swap button inside MetaMask.'],
  ['Paste the $DARE contract as “Swap to”',
    `Search won’t always surface a newer token — paste the contract ${short(DARE.contract)} directly and confirm it before selecting.`],
  ['Enter an amount and review',
    'Set the ETH amount, review the quote and network fee, then confirm the swap.'],
  ['Wait for confirmation',
    'Once it lands, $DARE appears in your MetaMask token list automatically.'],
]

function Steps({ steps }: { steps: [string, string][] }) {
  return (
    <ol className="space-y-3">
      {steps.map(([title, body], i) => (
        <li key={i} className="flex gap-3">
          <span className="mono text-[11px] text-[color:var(--blue-bright)] border border-[color:var(--edge-hot)] rounded w-6 h-6 flex items-center justify-center shrink-0 tabular-nums">
            {i + 1}
          </span>
          <div className="space-y-0.5 pt-0.5">
            <div className="text-[12px] text-white font-medium">{title}</div>
            <div className="text-[11px] leading-relaxed text-[color:var(--text-dim)]">{body}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function DareTokenPanel() {
  const [open,   setOpen]   = useState(false)
  const [method, setMethod] = useState<'uniswap' | 'metamask'>('uniswap')
  const [copied, setCopied] = useState(false)
  const [added,  setAdded]  = useState<'idle' | 'ok' | 'nowallet'>('idle')

  async function copyContract() {
    try {
      await navigator.clipboard.writeText(DARE.contract)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the address stays selectable by hand */ }
  }

  async function addToMetaMask() {
    const eth = getEth()
    if (!eth) { setAdded('nowallet'); setTimeout(() => setAdded('idle'), 3000); return }
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address:  DARE.contract,
            symbol:   DARE.symbol,
            decimals: DARE.decimals,
          },
        },
      })
      setAdded('ok'); setTimeout(() => setAdded('idle'), 3000)
    } catch { setAdded('idle') }
  }

  return (
    <div className="panel p-5 space-y-5">
      {/* Identity + contract */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="display text-[20px] text-white">$DARE</span>
            <span className="mono text-[11px] text-[color:var(--text-faint)]">{DARE.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="led bg-[color:var(--blue-bright)]" />
            <span className="mono text-[10px] tracking-[0.14em] text-[color:var(--blue-bright)]">
              {DARE.chain.toUpperCase()} · CHAIN {DARE.chainId}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <span className="legend">CONTRACT</span>
          <button
            onClick={copyContract}
            title="Copy contract address"
            className="row-toggle mono text-[11px] text-[color:var(--text-dim)] hover:text-white flex items-center gap-2 justify-end"
          >
            <span className="hidden sm:inline">{DARE.contract}</span>
            <span className="sm:hidden">{short(DARE.contract)}</span>
            <span className={`text-[10px] ${copied ? 'text-emerald-400' : 'text-[color:var(--blue-bright)]'}`}>
              {copied ? 'COPIED' : 'COPY'}
            </span>
          </button>
        </div>
      </div>

      {/* Primary actions */}
      <div className="flex flex-wrap gap-2">
        <a
          href={DARE.uniswap}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary rounded-md px-4 py-2 text-[12px]"
        >
          Buy on Uniswap ↗
        </a>
        <button onClick={addToMetaMask} className="btn-ghost rounded-md px-4 py-2 text-[12px]">
          {added === 'ok' ? 'Added ✓' : added === 'nowallet' ? 'No wallet found' : 'Add to MetaMask'}
        </button>
        <a href={DARE.coingecko} target="_blank" rel="noopener noreferrer"
           className="btn-ghost rounded-md px-4 py-2 text-[12px]">
          CoinGecko ↗
        </a>
        <a href={DARE.basescan} target="_blank" rel="noopener noreferrer"
           className="btn-ghost rounded-md px-4 py-2 text-[12px]">
          Basescan ↗
        </a>
      </div>

      {/* Expandable how-to */}
      <div className="border-t border-[color:var(--edge)] pt-4">
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="row-toggle flex items-center gap-3"
        >
          <span className={`mono text-[color:var(--text-faint)] text-xs transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden>▶</span>
          <span className="display text-[14px] text-white">How to purchase $DARE</span>
          <span className="legend hidden sm:inline">STEP BY STEP</span>
        </button>

        {open && (
          <div className="mt-4 space-y-4">
            {/* Method toggle */}
            <div className="flex gap-2">
              {(['uniswap', 'metamask'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`mono text-[11px] tracking-wide rounded-md px-3 py-1.5 border transition-colors ${
                    method === m
                      ? 'border-[color:var(--blue-bright)] text-white bg-[color:var(--blue-deep)]'
                      : 'border-[color:var(--edge)] text-[color:var(--text-dim)] hover:border-[color:var(--edge-hot)]'
                  }`}
                >
                  {m === 'uniswap' ? 'Uniswap (DEX)' : 'MetaMask Swap'}
                </button>
              ))}
            </div>

            <div className="bg-[#04060a] border border-[color:var(--edge)] rounded-lg p-4">
              <Steps steps={method === 'uniswap' ? UNISWAP_STEPS : METAMASK_STEPS} />
            </div>

            {/* Safety note — the one thing that actually protects a buyer. */}
            <div className="flex items-start gap-2.5">
              <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] mt-1" />
              <p className="text-[11px] leading-relaxed text-[color:var(--text-dim)]">
                Only ever swap into the contract above on {DARE.chain}. Verify it against{' '}
                <a href={DARE.coingecko} target="_blank" rel="noopener noreferrer" className="text-[color:var(--blue-bright)] hover:underline">CoinGecko</a>{' '}
                before approving — tokens that copy the name and ticker are common.
                This is information, not financial advice.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

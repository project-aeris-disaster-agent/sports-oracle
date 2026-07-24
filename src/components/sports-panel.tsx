'use client'

import { useState, useEffect, useRef } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import Link from 'next/link'
import {
  SPORTS, STATUS_META, endpointSource, groupedSports, badgesFor,
  VERTICALS, VERTICAL_META,
  type SportSpec, type SportStatus, type SourceRef, type BadgeTone, type Vertical,
} from '@/lib/capabilities'

/**
 * Licence posture, rendered honestly.
 *
 * This is a data router — where a number came from is part of the product, not
 * a footnote. `open` sources are named because we depend on community goodwill
 * and should say so; `unclear` is shown because a consumer deciding whether to
 * build a paid product on an endpoint deserves to know before they start.
 */
const LICENSE_META: Record<SourceRef['license'], { label: string; cls: string }> = {
  licensed: { label: 'LICENSED', cls: 'text-[color:var(--blue-bright)] border-[color:var(--blue-bright)]/30' },
  open:     { label: 'OPEN',     cls: 'text-emerald-400 border-emerald-400/30' },
  unclear:  { label: 'UNVERIFIED TERMS', cls: 'text-amber-400 border-amber-400/30' },
}

/**
 * Card indicators. Content comes from badgesFor() in the manifest — this is only
 * how a tone maps to colour, so a badge cannot say something the endpoint table
 * disagrees with.
 *
 * Deliberately reuses the palette already in play: emerald = open/available,
 * blue = the product's own accent, amber = proceed with care. A new colour here
 * would read as a new category of thing.
 */
const BADGE_TONE: Record<BadgeTone, string> = {
  settle:   'text-emerald-300 border-emerald-400/40 bg-emerald-400/[0.07]',
  live:     'text-[color:var(--blue-bright)] border-[color:var(--blue-bright)]/35 bg-[color:var(--blue-bright)]/[0.07]',
  open:     'text-emerald-400/90 border-emerald-400/25',
  licensed: 'text-[color:var(--text-dim)] border-[color:var(--edge)]',
  caution:  'text-amber-400 border-amber-400/30 bg-amber-400/[0.06]',
}

function CardBadges({ sport, className = '' }: { sport: SportSpec; className?: string }) {
  const badges = badgesFor(sport)
  if (!badges.length) return null
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {badges.map(b => (
        <span
          key={b.label}
          title={b.title}
          className={`mono text-[9px] tracking-[0.1em] px-1.5 py-0.5 rounded border whitespace-nowrap ${BADGE_TONE[b.tone]}`}
        >
          {b.label}
        </span>
      ))}
    </span>
  )
}

function SourceBadge({ src }: { src: SourceRef }) {
  const meta    = LICENSE_META[src.license]
  const offline = src.status === 'offline'
  const title = [
    src.attribution,
    src.isDefault ? 'default source' : `select with ?provider=${src.id}`,
    offline ? `OFFLINE — ${src.offlineReason ?? 'not currently serving'}` : null,
    src.authoritative ? null : 'provisional — not a settlement source',
  ].filter(Boolean).join(' · ')

  return (
    <a
      href={src.homepage}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`mono text-[10px] tracking-wide px-1.5 py-0.5 rounded border transition-colors hover:bg-white/5 ${
        offline
          ? 'text-[color:var(--text-faint)] border-[color:var(--edge)] border-dashed opacity-70'
          : meta.cls
      }`}
    >
      {src.label}
      {src.isDefault && <span className="opacity-50"> ·default</span>}
      {offline        && <span className="opacity-70"> ·offline</span>}
      {!offline && !src.authoritative && <span className="opacity-60"> ·prov</span>}
    </a>
  )
}

/**
 * Optional live health override for one sport, resolved server-side.
 *
 * Deliberately carries only a traffic-light state — no call counts, quotas or
 * utilisation. Those are commercially sensitive and must never reach the public
 * page; the dashboard is the place for operator-facing numbers.
 */
export interface SportLiveState {
  key:        string
  status:     SportStatus
  statusNote?: string
  /** True when measured rather than falling back to declared values. */
  measured?:   boolean
}

// ─── Endpoint probing ─────────────────────────────────────────────────────────
// Backed by /api/probe, which returns liveness only — never payload data.
//
// Requires a signed-in Privy session: probing calls real upstreams and some of
// them bill per request, so it is tied to an account that can be rate limited
// rather than to an anonymous visitor. Signed-out users get a sign-in prompt in
// place of the button instead of one that would only ever 401.

type ProbeState = 'live' | 'cached' | 'offline' | 'unavailable' | 'needs-params' | 'rate-limited' | 'error'

interface Probe {
  state:     ProbeState
  ok:        boolean
  latencyMs: number | null
  detail:    string
  status:    number | null
}

const PROBE_META: Record<ProbeState, { label: string; cls: string }> = {
  live:           { label: 'LIVE',    cls: 'text-emerald-400' },
  cached:         { label: 'CACHED',  cls: 'text-emerald-400' },
  offline:        { label: 'OFFLINE', cls: 'text-[color:var(--text-faint)]' },
  unavailable:    { label: 'N/A',     cls: 'text-[color:var(--text-faint)]' },
  'needs-params': { label: 'NEEDS ID', cls: 'text-amber-400' },
  'rate-limited': { label: 'SLOW DOWN', cls: 'text-amber-400' },
  error:          { label: 'ERROR',   cls: 'text-red-400' },
}

function EndpointTest({ sport, path, trigger = 0 }: { sport: string; path: string; trigger?: number }) {
  const { ready, authenticated, getAccessToken, login } = usePrivy()
  const [probe, setProbe] = useState<Probe | null>(null)
  const [busy, setBusy]   = useState(false)
  const [readyTimedOut, setReadyTimedOut] = useState(false)

  useEffect(() => {
    if (ready) return
    const t = setTimeout(() => setReadyTimedOut(true), 3000)
    return () => clearTimeout(t)
  }, [ready])

  // "Test all" bumps `trigger`; each row runs itself rather than the parent
  // orchestrating a fan-out, so one slow endpoint never blocks the others.
  useEffect(() => {
    if (trigger > 0 && authenticated) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, authenticated])

  async function run() {
    setBusy(true)
    try {
      // Probing calls real, sometimes paid, upstreams — the server requires a
      // session and rate limits per account. Sending the token is what ties a
      // probe to an account rather than to an IP.
      const token = await getAccessToken()
      const r = await fetch(`/api/probe?sport=${sport}&endpoint=${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const j = await r.json()
      setProbe(r.ok
        ? j
        : {
            state:  r.status === 429 ? 'rate-limited' : 'error',
            ok:     false,
            latencyMs: null,
            status: r.status,
            detail: j.error ?? 'Probe failed.',
          })
    } catch (e) {
      setProbe({ state: 'error', ok: false, latencyMs: null, status: null, detail: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  // Privy can fail to initialise entirely — blocked network, an embedded
  // browser, an ad blocker. Waiting on `ready` forever would leave a row of dead
  // ellipses with no explanation, so after a short grace period fall through to
  // the sign-in prompt: clicking it surfaces Privy's own error, which is far
  // more useful than a control that never resolves.
  if (!ready && !readyTimedOut) {
    return <span className="mono text-[10px] text-[color:var(--text-faint)]">…</span>
  }

  // Signed out: offer the sign-in rather than a button that would just 401.
  if (!authenticated) {
    return (
      <button
        onClick={() => login()}
        title="Endpoint testing calls live upstreams, so it needs a signed-in account."
        className="mono text-[10px] tracking-wide text-[color:var(--text-faint)] hover:text-[color:var(--blue-bright)] hover:underline"
      >
        Sign in to test
      </button>
    )
  }

  if (busy) {
    return <span className="mono text-[10px] text-[color:var(--text-faint)] animate-pulse">testing…</span>
  }

  if (probe) {
    const meta = PROBE_META[probe.state] ?? PROBE_META.error
    return (
      <button
        onClick={run}
        title={`${probe.detail} — click to re-test`}
        className={`mono text-[10px] tracking-wide ${meta.cls} hover:underline`}
      >
        {probe.ok && <span aria-hidden>✓ </span>}
        {meta.label}
        {probe.latencyMs != null && <span className="opacity-60"> {probe.latencyMs}ms</span>}
      </button>
    )
  }

  return (
    <button
      onClick={run}
      className="mono text-[10px] tracking-wide text-[color:var(--blue-bright)] hover:underline"
    >
      Test
    </button>
  )
}

function SportRow({ sport, state }: { sport: SportSpec; state?: SportLiveState }) {
  const { authenticated } = usePrivy()
  const [open, setOpen] = useState(false)
  const [testAll, setTestAll] = useState(0)
  // Live state wins when supplied — capabilities.ts describes the shape of a
  // sport, a live probe describes its current condition.
  const status = state?.status ?? sport.status
  const note   = state?.statusNote ?? sport.statusNote
  const meta   = STATUS_META[status]
  const live   = status === 'online'

  return (
    <div className={`panel panel-hover overflow-hidden ${status === 'offline' ? 'opacity-55' : ''}`}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="row-toggle flex items-center gap-4 px-4 py-3.5"
      >
        <span className={`led ${meta.dot} ${meta.ring} ${live ? 'led-pulse' : ''}`} />

        <span className="flex items-baseline gap-2.5 min-w-0">
          <span className="display text-[15px] text-white">{sport.label}</span>
          <span className="mono text-[11px] text-[color:var(--text-faint)]">{sport.key}</span>
        </span>

        <span className={`mono text-[10px] tracking-[0.14em] ${meta.text} hidden sm:inline`}>
          {meta.label}
        </span>

        {/* Capability indicators, visible without expanding. Hidden below md —
            on a phone the label and status are what matter and these would wrap
            the row onto three lines. */}
        <CardBadges sport={sport} className="hidden md:flex" />

        <span className="flex-1" />

        {/* Source attribution is visible without expanding the row — it is a
            primary fact about a sport, not detail. */}
        {/* Collapsed row shows what is actually serving. Alternates and offline
            sources are one click away rather than cluttering every row. */}
        {sport.sources.some(s => s.status === 'live') && (
          <span className="hidden lg:flex items-center gap-1.5">
            {sport.sources.filter(s => s.status === 'live').map(src => (
              <span
                key={src.id}
                title={src.attribution}
                className={`mono text-[10px] tracking-wide ${
                  src.license === 'open'    ? 'text-emerald-400/80'
                  : src.license === 'unclear' ? 'text-amber-400/80'
                  : 'text-[color:var(--text-faint)]'
                }`}
              >
                {src.label}
              </span>
            ))}
            {sport.sources.some(s => s.status === 'offline') && (
              <span
                className="mono text-[10px] text-[color:var(--text-faint)] opacity-70"
                title="Additional sources are registered but not yet serving — expand for details."
              >
                +{sport.sources.filter(s => s.status === 'offline').length}
              </span>
            )}
          </span>
        )}

        <span className="mono text-[11px] text-[color:var(--text-dim)] tabular-nums hidden md:inline">
          {sport.endpoints.length > 0 ? `${sport.endpoints.length} endpoints` : '—'}
        </span>

        <span
          className={`mono text-[color:var(--text-faint)] text-xs transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          aria-hidden
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="border-t border-[color:var(--edge)] bg-[#04060a]">
          <div className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[color:var(--edge)]">
            {/* Repeated here for the breakpoints where the collapsed row hides
                them — expanding must never show LESS than the row it came from. */}
            <CardBadges sport={sport} className="md:hidden" />
            <span className="text-[11px] text-[color:var(--text-dim)]">{note}</span>
            <span className="flex items-center gap-2">
              <span className="legend">SEASON</span>
              <span className="mono text-[11px] text-white">{sport.season}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="legend">TYPE</span>
              <span className="mono text-[11px] text-white">
                {sport.teamBased ? 'TEAM' : 'INDIVIDUAL'}
              </span>
            </span>
            {sport.sources.length > 0 && (
              <span className="flex items-center gap-2">
                <span className="legend">SOURCE</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {sport.sources.map(src => <SourceBadge key={src.id} src={src} />)}
                </span>
              </span>
            )}
          </div>

          {sport.note && (
            <p className="px-4 pt-3 text-[11px] leading-relaxed text-[color:var(--text-dim)]">
              {sport.note}
            </p>
          )}

          {/* The router half of the product: more than one upstream can answer
              this sport, and the caller picks. Only worth saying when true. */}
          {sport.sources.length > 1 && (
            <p className="px-4 pt-3 text-[11px] leading-relaxed text-[color:var(--text-dim)]">
              <span className="legend">ROUTING</span>{' '}
              Defaults to{' '}
              <span className="mono text-white">
                {sport.sources.find(s => s.isDefault)?.label}
              </span>
              . Select another with{' '}
              <code className="mono text-[color:var(--blue-bright)]">?provider=</code>
              {sport.sources.filter(s => !s.isDefault).map((s, i) => (
                <span key={s.id}>
                  {i === 0 ? ' ' : ', '}
                  <code className={`mono ${s.status === 'offline'
                    ? 'text-[color:var(--text-faint)]'
                    : 'text-[color:var(--blue-bright)]'}`}>
                    {s.id}
                  </code>
                  {s.status === 'offline' && (
                    <span className="text-[color:var(--text-faint)]"> (offline)</span>
                  )}
                </span>
              ))}
              .
            </p>
          )}

          {/* Endpoints are shown whenever a sport declares any, entitled or not.
              A registered-but-offline source is still worth publishing — an
              integrator deciding whether to wait for it needs to see the shape
              it will take. The row header and note already say it isn't live. */}
          {sport.endpoints.length > 0 ? (
            <>
              <div className="px-4 py-3 overflow-x-auto">
                <table className="w-full text-[11px] border-separate border-spacing-y-1">
                  <thead>
                    <tr className="legend">
                      <th className="text-left font-normal pb-1">Endpoint</th>
                      <th className="text-left font-normal pb-1">Params</th>
                      <th className="text-left font-normal pb-1">Tier</th>
                      <th className="text-left font-normal pb-1">Source</th>
                      <th className="text-left font-normal pb-1">Status</th>
                      <th className="text-left font-normal pb-1 hidden lg:table-cell">Use</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sport.endpoints.map(e => {
                      const src = endpointSource(sport.key, e.path)
                      return (
                        <tr key={e.path}>
                          <td className="mono text-[color:var(--blue-bright)] whitespace-nowrap pr-4">
                            /{e.path}
                          </td>
                          <td className="mono text-[color:var(--text-faint)] whitespace-nowrap pr-4">
                            {e.params.join(', ') || '—'}
                          </td>
                          <td className="pr-4">
                            <span className={`mono text-[10px] tracking-wider ${
                              e.minTier === 'analyst'
                                ? 'text-[color:var(--blue-bright)]'
                                : 'text-[color:var(--text-faint)]'
                            }`}>
                              {(e.minTier ?? 'scout').toUpperCase()}
                            </span>
                          </td>
                          {/* Per-endpoint, because one sport can span upstreams —
                              F1 settles on Jolpica and streams from OpenF1. */}
                          <td className="pr-4 whitespace-nowrap">
                            <span
                              title={src?.attribution}
                              className={`mono text-[10px] ${
                                src?.license === 'open'    ? 'text-emerald-400/80'
                                : src?.license === 'unclear' ? 'text-amber-400/80'
                                : 'text-[color:var(--text-faint)]'
                              }`}
                            >
                              {src?.label ?? '—'}
                            </span>
                          </td>
                          {/* Live probe — proves the endpoint answers, without
                              needing a key and without returning any data. */}
                          <td className="pr-4 whitespace-nowrap">
                            <EndpointTest sport={sport.key} path={e.path} trigger={testAll} />
                          </td>
                          <td className="text-[color:var(--text-dim)] hidden lg:table-cell">
                            {e.desc}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="px-4 pb-4 pt-1 flex flex-wrap items-center gap-3">
                <Link
                  href={`/dashboard?sport=${sport.key}`}
                  className="btn-primary rounded-md px-3.5 py-2 text-[12px]"
                >
                  Get API access
                </Link>
                {/* Fans out one probe per row. Hidden when signed out — every
                    row already shows its own sign-in prompt, so offering a bulk
                    action that cannot run would just be a dead control. */}
                {authenticated && (
                  <button
                    onClick={() => setTestAll(n => n + 1)}
                    className="btn-ghost rounded-md px-3 py-2 text-[12px]"
                  >
                    Test all endpoints
                  </button>
                )}
                <code className="mono text-[11px] text-[color:var(--text-faint)] truncate">
                  GET /api/v1/{sport.key}
                </code>
              </div>
            </>
          ) : (
            <div className="px-4 py-4 flex flex-wrap items-center gap-3">
              <span className="mono text-[11px] text-red-400">
                Currently unavailable.
              </span>
              <Link href="/dashboard" className="btn-ghost rounded-md px-3 py-1.5 text-[12px]">
                Notify me
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function SportsPanel({ states = [], live = false }: { states?: SportLiveState[]; live?: boolean }) {
  const byKey = new Map((states ?? []).map(s => [s.key, s]))
  const [tab, setTab] = useState<Vertical>('traditional')
  const tabRefs = useRef<Partial<Record<Vertical, HTMLButtonElement | null>>>({})

  // Arrow keys move between tabs and move focus with the selection, per the
  // WAI-ARIA tabs pattern. Home/End jump to the ends.
  function onTabKeyDown(e: React.KeyboardEvent) {
    const i = VERTICALS.indexOf(tab)
    let next = i
    if (e.key === 'ArrowRight')     next = (i + 1) % VERTICALS.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + VERTICALS.length) % VERTICALS.length
    else if (e.key === 'Home')      next = 0
    else if (e.key === 'End')       next = VERTICALS.length - 1
    else return

    e.preventDefault()
    const key = VERTICALS[next]
    setTab(key)
    tabRefs.current[key]?.focus()
  }

  // A sport missing from the live lookup falls back to its declared state, so a
  // partial result degrades one row rather than the whole panel.
  const statusOf = (spec: SportSpec): SportStatus => byKey.get(spec.key)?.status ?? spec.status

  const online  = SPORTS.filter(s => statusOf(s) === 'online').length
  const limited = SPORTS.filter(s => statusOf(s) === 'limited').length
  const offline = SPORTS.filter(s => statusOf(s) === 'offline').length
  const isLive  = live && states.length > 0

  // Ordered by measured status where we have it, so a sport that has actually
  // gone down sinks rather than sitting at the top on the strength of what the
  // manifest declares. Sorting is defined in capabilities.ts — see groupedSports.
  const groups = groupedSports(statusOf)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1">
        <span className="legend">SERVICE STATUS</span>
        <span className="flex items-center gap-1.5">
          <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          <span className="mono text-[11px] text-[color:var(--text-dim)]">{online} operational</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
          <span className="mono text-[11px] text-[color:var(--text-dim)]">{limited} limited</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="led bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
          <span className="mono text-[11px] text-[color:var(--text-dim)]">{offline} offline</span>
        </span>

        <span className="flex-1" />

        {/* Be explicit when these figures are the declared fallback rather than
            measured — "we couldn't check" must not read as "all clear". */}
        {!isLive && (
          <span className="mono text-[10px] text-[color:var(--text-faint)]">
            STATUS CHECK UNAVAILABLE
          </span>
        )}
      </div>

      {/* ─── Vertical tabs ──────────────────────────────────────────────────
          Roving-tabindex tablist: one tab in the tab order, arrow keys move
          between them. That is the WAI-ARIA pattern — without it a keyboard user
          has to tab through every tab to reach the panel below, which gets worse
          with each vertical we add. */}
      <div
        role="tablist"
        aria-label="Coverage verticals"
        className="flex items-stretch gap-1 border-b border-[color:var(--edge)] -mb-px overflow-x-auto"
        onKeyDown={onTabKeyDown}
      >
        {VERTICALS.map(v => {
          const meta     = VERTICAL_META[v]
          const view     = groups.find(g => g.group === v)
          const selected = v === tab
          return (
            <button
              key={v}
              id={`tab-${v}`}
              role="tab"
              ref={el => { tabRefs.current[v] = el }}
              aria-selected={selected}
              aria-controls={`panel-${v}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(v)}
              className={`group flex items-center gap-2 px-3.5 py-2.5 border-b-2 whitespace-nowrap transition-colors ${
                selected
                  ? 'border-[color:var(--blue-bright)] text-white'
                  : 'border-transparent text-[color:var(--text-dim)] hover:text-white hover:border-[color:var(--edge-hot)]'
              }`}
            >
              <span className="display text-[13px]">{meta.label}</span>

              {/* Available verticals show what is actually serving; an announced
                  one says so instead of showing a zero, which would read as
                  "broken" rather than "not built yet". */}
              {meta.available ? (
                <span className="mono text-[10px] tabular-nums text-[color:var(--text-faint)]">
                  {view?.serving ?? 0}/{view?.sports.length ?? 0}
                </span>
              ) : (
                <span className="mono text-[9px] tracking-[0.1em] px-1.5 py-0.5 rounded border border-amber-400/30 text-amber-400">
                  SOON
                </span>
              )}
            </button>
          )
        })}
      </div>

      {VERTICALS.map(v => {
        if (v !== tab) return null
        const meta = VERTICAL_META[v]
        const view = groups.find(g => g.group === v)

        return (
          <section
            key={v}
            id={`panel-${v}`}
            role="tabpanel"
            aria-labelledby={`tab-${v}`}
            tabIndex={0}
            className="space-y-3 pt-4 focus:outline-none"
          >
            <p className="text-[11px] leading-relaxed text-[color:var(--text-dim)] px-1">
              {meta.blurb}
            </p>

            {meta.available && view
              ? view.sports.map(s => <SportRow key={s.key} sport={s} state={byKey.get(s.key)} />)
              : (
                <div className="panel px-5 py-6 space-y-3">
                  <div className="flex items-center gap-2.5">
                    <span className="led bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
                    <span className="display text-[15px] text-white">{meta.label}</span>
                    <span className="mono text-[10px] tracking-[0.14em] text-amber-400">
                      NOT YET AVAILABLE
                    </span>
                  </div>
                  {meta.soon && (
                    <p className="text-[12px] leading-relaxed text-[color:var(--text-dim)] max-w-3xl">
                      {meta.soon}
                    </p>
                  )}
                  <Link href="/dashboard" className="btn-ghost rounded-md px-3 py-1.5 text-[12px] inline-block">
                    Notify me
                  </Link>
                </div>
              )}
          </section>
        )
      })}
    </div>
  )
}

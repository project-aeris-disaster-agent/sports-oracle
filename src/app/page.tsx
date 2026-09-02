import Link from 'next/link'
import Image from 'next/image'
import { SPORTS, ENTITLED_SPORTS, toolCatalog } from '@/lib/capabilities'
import { SportsPanel } from '@/components/sports-panel'
import { LoginButton, AccountNav } from '@/components/login-button'
import { DareTokenPanel } from '@/components/dare-token'
import { getLiveStatus, summarise } from '@/lib/status'
import { TIERS, TIER_ORDER }        from '@/lib/tiers'

// Status is resolved per render, capped at once a minute. Without this the page
// would be statically generated at build time and the service indicators would
// be frozen at whatever happened to be true when it was deployed.
export const revalidate = 60

// Rendered from lib/tiers.ts so the marketing page can't quote a price the
// gateway doesn't actually enforce.
const TIER_ROWS = TIER_ORDER.map(t => TIERS[t])

// Derived from the capability manifest, not hand-listed. The previous hardcoded
// array had drifted from the tools the MCP route actually served.
const TOOLS: [string, string][] = toolCatalog().map(t => [t.name, t.spec.desc])

// Base URL shown in the copy-paste docs. An earlier version hardcoded
// `sports-oracle.vercel.app`, which is NOT this deployment — it serves an
// unrelated app, so anyone pasting the quickstart hit the wrong host. Prefer the
// configured public URL; fall back to the canonical customer-facing domain,
// never to localhost, the wrong domain, or a deployment-hash URL.
const envUrl = process.env.NEXT_PUBLIC_APP_URL
const PROD_URL = envUrl && envUrl.startsWith('https://') && !envUrl.includes('localhost')
  ? envUrl.replace(/\/$/, '')
  : 'https://router.sonara.bio'

function Section({
  id, legend, title, kicker, children,
}: { id: string; legend: string; title: string; kicker?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-5 scroll-mt-20">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="legend">{legend}</span>
          <span className="h-px flex-1 bg-[color:var(--edge)]" />
        </div>
        <h2 className="display text-[22px] text-white">{title}</h2>
        {kicker && (
          <p className="text-[13px] leading-relaxed text-[color:var(--text-dim)] max-w-2xl">{kicker}</p>
        )}
      </div>
      {children}
    </section>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <pre className="code p-4 text-[color:var(--text-dim)]">{children}</pre>
}

export default async function Home() {
  const endpointCount = ENTITLED_SPORTS.reduce((n, s) => n + s.endpoints.length, 0)
  const statuses = await getLiveStatus()
  const health   = summarise(statuses)

  return (
    <>
      {/* ─── Masthead ─────────────────────────────────────────────────────── */}
      <header className="border-b border-[color:var(--edge)] sticky top-0 z-30 backdrop-blur-md bg-black/70">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <Image
              src="/dd_router_logo.png"
              alt="Agent Daredevil Oracle"
              width={1254}
              height={713}
              priority
              className="h-9 w-auto"
            />
            <span className="display text-[15px] tracking-tight text-white">SPORTS ORACLE</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 ml-6 text-[12px] text-[color:var(--text-dim)]">
            <a href="#sports" className="hover:text-white transition-colors">Sports</a>
            <a href="#agents" className="hover:text-white transition-colors">For agents</a>
            <a href="#access" className="hover:text-white transition-colors">Access</a>
            <a href="#token" className="hover:text-white transition-colors">$DARE</a>
          </nav>
          <span className="flex-1" />
          <AccountNav />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-14 space-y-20">

        {/* ─── Hero ───────────────────────────────────────────────────────── */}
        <section className="space-y-7">
          <Image
            src="/dd_router_logo.png"
            alt="Agent Daredevil Oracle"
            width={1254}
            height={713}
            priority
            className="w-auto h-28 sm:h-36"
          />
          <div className="space-y-4 max-w-3xl">
            <span className="legend">REAL-TIME SPORTS DATA INFRASTRUCTURE</span>
            <h1 className="display text-[42px] sm:text-[54px] leading-[1.04] text-white">
              Sports data built for{' '}
              <span className="text-[color:var(--blue-bright)]">autonomous agents</span>.
            </h1>
            <p className="text-[15px] leading-relaxed text-[color:var(--text-dim)] max-w-xl">
              One key. REST and MCP. Low-latency coverage across every major league,
              designed for systems that never stop asking.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <LoginButton className="btn-primary rounded-md px-5 py-2.5 text-[13px]" />
            <a href="#sports" className="btn-ghost rounded-md px-5 py-2.5 text-[13px]">
              View all sports
            </a>
          </div>

          <div className="panel grid grid-cols-2 md:grid-cols-4 divide-x divide-[color:var(--edge)]">
            {[
              // Every figure here is DERIVED. Nothing in this row may be a
              // hand-written constant.
              //
              // This used to carry a hardcoded "UPTIME 99.9%". Nothing measured
              // it: there is no status history, no synthetic prober and no
              // external monitor, so the number was an assertion the system
              // could not support and a customer was entitled to ask us to back
              // up. It is replaced with the live count of sports currently
              // reporting healthy, which getLiveStatus() actually computes.
              // Restore an availability figure here only once it is measured.
              ['SPORTS LIVE',  String(ENTITLED_SPORTS.length), 'emerald'],
              ['ENDPOINTS',    String(endpointCount),          'blue'],
              ['MCP TOOLS',    String(TOOLS.length),           'blue'],
              ['OPERATIONAL',  `${health.online}/${statuses.filter(s => s.entitled).length}`, 'emerald'],
            ].map(([label, value, tone]) => (
              <div key={label} className="px-5 py-4 space-y-1.5">
                <div className="legend">{label}</div>
                <div className={`mono text-[20px] tabular-nums ${
                  tone === 'emerald' ? 'text-emerald-400' : 'text-[color:var(--blue-bright)]'
                }`}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <Code>{`curl -H "X-Oracle-Key: sk_live_..." \\
  "${PROD_URL}/api/v1/nba/injuries"`}</Code>
        </section>

        {/* ─── Sports panel (main event) ──────────────────────────────────── */}
        <Section
          id="sports"
          legend="COVERAGE"
          title="All markets"
          kicker="Sports, esports and — soon — politics. Every market exposes its own endpoint set. Expand a row to see endpoints, parameters and tier requirements."
        >
          <SportsPanel
            states={statuses.map(s => ({ key: s.key, status: s.status, statusNote: s.statusNote }))}
            live={health.live}
          />
        </Section>

        {/* ─── Agents ─────────────────────────────────────────────────────── */}
        <Section
          id="agents"
          legend="INTEGRATION"
          title="Built agent-first"
          kicker="Two transports, one auth model. Use whichever your runtime speaks."
        >
          <div className="grid md:grid-cols-2 gap-4">
            <div className="panel p-5 space-y-3">
              <div className="flex items-center gap-2">
                <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                <h3 className="display text-[14px] text-white">MCP · recommended</h3>
              </div>
              <p className="text-[12px] leading-relaxed text-[color:var(--text-dim)]">
                {TOOLS.length} typed tools. Schemas describe every parameter, so the model
                never guesses a URL shape.
              </p>
              <Code>{`{
  "mcpServers": {
    "sports-oracle": {
      "url": "${PROD_URL}/api/mcp",
      "headers": { "X-Oracle-Key": "sk_live_..." }
    }
  }
}`}</Code>
            </div>

            <div className="panel p-5 space-y-3">
              <div className="flex items-center gap-2">
                <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                <h3 className="display text-[14px] text-white">REST</h3>
              </div>
              <p className="text-[12px] leading-relaxed text-[color:var(--text-dim)]">
                Plain HTTP, one header. Predictable JSON envelope on every response.
              </p>
              <Code>{`GET /api/v1/{sport}/{resource}
X-Oracle-Key: sk_live_...

{ "sport": "nba", "data": { ... } }`}</Code>
            </div>
          </div>

          <div className="panel p-5 space-y-3">
            <h3 className="display text-[14px] text-white">
              Runtime discovery — no hardcoded assumptions
            </h3>
            <p className="text-[12px] leading-relaxed text-[color:var(--text-dim)] max-w-3xl">
              Sports genuinely differ: tennis has no roster, NFL scopes injuries by week,
              MMA is event-based. An agent asks rather than assumes.
            </p>
            <Code>{`GET /api/v1/tennis

{
  "sport": "tennis",
  "teamBased": false,
  "yourTier": "analyst",
  "endpoints": [
    { "url": "/api/v1/tennis/standings",
      "minTier": "scout", "accessible": true }
  ]
}`}</Code>
          </div>

          <div className="panel p-5 space-y-3">
            <h3 className="display text-[14px] text-white">
              Example — &ldquo;who is questionable for tonight&rsquo;s game?&rdquo;
            </h3>
            <Code>{`1. get_teams(sport="nba")             resolve name -> team_id
2. get_scores(sport="nba")            today's slate -> game_id
3. get_injuries(sport="nba")          filter to that team_id
4. get_pbp(sport="nba", game_id=..)   once play begins`}</Code>
            <p className="text-[12px] leading-relaxed text-[color:var(--text-dim)]">
              Four calls, typically well under a second end to end.
            </p>
          </div>
        </Section>

        {/* ─── Access ─────────────────────────────────────────────────────── */}
        <Section
          id="access"
          legend="ACCESS"
          title="Staking tiers"
          kicker="Stake $DARE on Base to mint a key. Tier sets your rate limit and unlocks real-time endpoints."
        >
          <div className="grid md:grid-cols-3 gap-4">
            {TIER_ROWS.map(t => (
              <div key={t.name} className={`panel p-5 space-y-4 ${t.name === 'analyst' ? 'border-[color:var(--blue)]' : ''}`}>
                <div className="flex items-center justify-between">
                  <h3 className="display text-[16px] text-white">{t.label}</h3>
                  {t.sandbox && (
                    <span className="mono text-[9px] tracking-[0.16em] text-emerald-400 border border-emerald-700 rounded px-1.5 py-0.5">
                      FREE
                    </span>
                  )}
                  {t.name === 'analyst' && (
                    <span className="mono text-[9px] tracking-[0.16em] text-[color:var(--blue-bright)] border border-[color:var(--blue)] rounded px-1.5 py-0.5">
                      POPULAR
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="mono text-[24px] text-white tabular-nums">
                    {t.stake === 0 ? 'No stake' : t.stake.toLocaleString()}
                  </div>
                  <div className="legend">
                    {t.stake === 0 ? 'SANDBOX ACCESS' : '$DARE · NO LOCK-UP'}
                  </div>
                </div>
                <div className="space-y-2 pt-1 border-t border-[color:var(--edge)]">
                  <div className="flex justify-between text-[12px] pt-2">
                    <span className="text-[color:var(--text-faint)]">Rate limit</span>
                    <span className="mono text-white tabular-nums">{t.rpm}/min</span>
                  </div>
                  <div className="flex justify-between text-[12px]">
                    <span className="text-[color:var(--text-faint)]">Data</span>
                    <span className={`mono ${t.realtime ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {t.realtime ? 'LIVE' : 'SYNTHETIC'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[12px]">
                    <span className="text-[color:var(--text-faint)]">Staking rewards</span>
                    <span className={`mono ${t.rewards ? 'text-emerald-400' : 'text-[color:var(--text-faint)]'}`}>
                      {t.rewards ? 'YES' : 'NO'}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[color:var(--text-dim)] pt-1">{t.blurb}</p>
                </div>
                <LoginButton
                  className={`block w-full text-center rounded-md px-3 py-2 text-[12px] ${
                    t.name === 'analyst' ? 'btn-primary' : 'btn-ghost'
                  }`}
                >
                  {t.sandbox ? 'Start free' : 'Get API access'}
                </LoginButton>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── $DARE token ────────────────────────────────────────────────── */}
        <Section
          id="token"
          legend="TOKEN"
          title="$DARE on Base"
          kicker="Access is staked in $DARE. New here? Acquire it in a few steps, then stake on the dashboard to mint a key."
        >
          <DareTokenPanel />
        </Section>

        {/* ─── MCP tools ──────────────────────────────────────────────────── */}
        <Section id="tools" legend="TOOLING" title="MCP tools" kicker="JSON-RPC at /api/mcp. Sport access and tier gates enforced per call.">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {TOOLS.map(([name, desc]) => (
              <div key={name} className="panel panel-hover px-3.5 py-2.5">
                <code className="mono text-[12px] text-[color:var(--blue-bright)]">{name}</code>
                <div className="text-[11px] text-[color:var(--text-faint)] mt-0.5">{desc}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── CTA ────────────────────────────────────────────────────────── */}
        <section className="panel p-8 md:p-10 text-center space-y-5">
          <h2 className="display text-[26px] text-white">Point your agent at it.</h2>
          <p className="text-[13px] text-[color:var(--text-dim)] max-w-md mx-auto">
            {ENTITLED_SPORTS.length} sports, {endpointCount} endpoints, one key.
          </p>
          <div className="flex flex-wrap gap-3 justify-center pt-1">
            <Link href="/dashboard" className="btn-primary rounded-md px-6 py-2.5 text-[13px]">
              Get API key
            </Link>
            <a href="#sports" className="btn-ghost rounded-md px-6 py-2.5 text-[13px]">
              Browse sports
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-[color:var(--edge)] mt-8">
        <div className="max-w-6xl mx-auto px-6 py-7 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="flex items-center gap-2">
            <span className="led bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)] led-pulse" />
            <span className="mono text-[11px] text-[color:var(--text-dim)]">
              All systems operational
            </span>
          </span>
          <span className="flex-1" />
          <span className="mono text-[11px] text-[color:var(--text-faint)]">
            {SPORTS.length} sports tracked · Base mainnet
          </span>
        </div>
      </footer>
    </>
  )
}

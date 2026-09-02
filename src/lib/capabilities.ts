// src/lib/capabilities.ts
// Single source of truth for what each sport actually supports.
//
// Every entry below reflects what the production Sportradar key can really reach
// (verified by live probe, not by documentation). The landing page, the per-sport
// discovery endpoint, and the MCP tool descriptions all read from here so they
// can't drift apart.

import { sourceRefs, resolveProvider, toSourceRef, type SourceRef } from '@/lib/providers'

export type { SourceRef }

export type Tier = 'scout' | 'analyst' | 'oracle'

export interface EndpointSpec {
  /** Path segment under /api/v1/{sport}/ */
  path:     string
  /** Sportradar data_type this maps to. */
  dataType: string
  params:   string[]
  /** Cache lifetime in seconds. */
  ttl:      number
  /** Minimum tier. Omitted means all tiers. */
  minTier?: Tier
  desc:     string
  /** Why a bettor / prediction market cares. */
  signal?:  string
}

/**
 * Service state for a sport, surfaced as a colour indicator in the UI.
 *   online   — green   · full endpoint set, normal capacity
 *   limited  — yellow  · reachable but capacity-constrained; poll conservatively
 *   offline  — neutral · shown as ROUTING — registered and integrating soon
 */
export type SportStatus = 'online' | 'limited' | 'offline'

export interface SportSpec {
  key:       string
  label:     string
  entitled:  boolean
  status:    SportStatus
  /** Short, human explanation of the status shown next to the indicator. */
  statusNote: string
  /** Monthly request headroom, expressed as a UI-friendly band. */
  capacity:  'high' | 'medium' | 'low' | 'none'
  /** Individual-competitor sports have no team/roster concept. */
  teamBased: boolean
  season:    string
  endpoints: EndpointSpec[]
  note?:     string
  /**
   * Display grouping. Purely presentational — esports keys live in the same flat
   * namespace as every other sport (`/api/v1/dota2/...`, one `sport_mask` entry),
   * because a separate namespace would need its own route tree and mask semantics
   * for no functional gain. This exists only so the UI can render a section.
   */
  group?:    'esports'
  /**
   * Upstream provenance, attached automatically from the routing table.
   *
   * This is a data router: which upstream a sport is served from is a product
   * fact, not an implementation detail. Consumers evaluating whether to build on
   * an endpoint need to know if it is licensed or community-run, and whether it
   * can settle a market. Never hand-write this — it is derived so it cannot
   * drift from what the router actually does.
   */
  sources:   SourceRef[]
}

// 'offline' is presented as ROUTING — a source registered and on the way, not a
// broken endpoint. Its indicator is a neutral dim dot rather than red: red reads
// as "error", which is the opposite of the intended "integrating soon" narrative,
// and it stays out of the red/amber/green indicator set so those keep single
// meanings (live / degraded / error).
// ─── Finality policy ──────────────────────────────────────────────────────────
// How, and how fast, a result becomes `official` for each settleable sport.
// Published in the manifest and on every /resolve response so a market can set
// its settlement timeout from a stated rule rather than an email.
//
// `edgeLagSeconds` is measured, not assumed: every Sportradar document probed on
// 2026-09-02 came through CloudFront with max-age=601, so a status change can
// take up to ten minutes to reach us on top of whatever the league takes.
export type FinalityRule =
  | 'upstream_state'   // the upstream publishes a distinct final state; we mirror it
  | 'upstream_gated'   // the upstream only publishes once the governing body has
  | 'ageing_window'    // our own hold: official once unchanged for windowSeconds
  | 'explicit_flag'    // the upstream sends an explicit final/void/provisional flag

export interface FinalityPolicy {
  rule:            FinalityRule
  /** Our hold, where rule is ageing_window. */
  windowSeconds?:  number
  /** Upstream edge-cache lag we cannot beat. */
  edgeLagSeconds?: number
  /** Days after official during which the settlement-watch job keeps re-checking. */
  revisionWatchDays: number
  description:     string
}

const SPORTRADAR_FINALITY: FinalityPolicy = {
  rule: 'upstream_state', edgeLagSeconds: 601, revisionWatchDays: 3,
  description: 'Sportradar publishes `complete` (played, statistics unreviewed) and `closed` '
             + '(statistics final) as separate states. Only `closed` reports official; `complete` '
             + 'is held at provisional. Typically minutes after the final whistle, plus up to ten '
             + 'minutes of upstream edge caching.',
}

export const FINALITY: Record<string, FinalityPolicy> = {
  nba: SPORTRADAR_FINALITY, nhl: SPORTRADAR_FINALITY, wnba: SPORTRADAR_FINALITY,
  nfl: SPORTRADAR_FINALITY, mlb: SPORTRADAR_FINALITY, tennis: SPORTRADAR_FINALITY, mma: SPORTRADAR_FINALITY,
  soccer: {
    rule: 'upstream_state', revisionWatchDays: 3,
    description: 'Official the moment TxLINE emits the game_finalised marker (StatusId 100) in the '
               + 'score stream, typically seconds to minutes after full time. Unconfirmed events '
               + '(VAR-revocable) are ignored until confirmed. The settled sequence number is '
               + 'returned as settled_seq for Merkle verification.',
  },
  f1: {
    rule: 'upstream_gated', revisionWatchDays: 30,
    description: 'Jolpica publishes a classification only once the FIA has made it official, after '
               + 'scrutineering and stewards decisions, usually one to three hours after the flag. '
               + 'The FIA can still revise a classification on appeal, which is why this sport has '
               + 'the longest revision watch.',
  },
  dota2: {
    rule: 'ageing_window', windowSeconds: 6 * 3600, revisionWatchDays: 3,
    description: 'A completed match is held at provisional for six hours after it ends, because '
               + 'OpenDota cannot distinguish a first replay parse from a settled one and technical '
               + 'remakes exist. This is our rule, not an upstream signal.',
  },
  agentfighter: {
    rule: 'explicit_flag', revisionWatchDays: 3,
    description: 'The operator publishes an explicit settlement field (final, void, provisional) '
               + 'and we mirror it directly. Effectively immediate on final.',
  },
}

export function finalityFor(sport: string): FinalityPolicy | undefined {
  return FINALITY[sport]
}

export const STATUS_META: Record<SportStatus, { label: string; dot: string; text: string; ring: string }> = {
  online:  { label: 'OPERATIONAL', dot: 'bg-emerald-400',              text: 'text-emerald-400',            ring: 'shadow-[0_0_8px_rgba(52,211,153,0.9)]' },
  limited: { label: 'LIMITED',     dot: 'bg-amber-400',                text: 'text-amber-400',              ring: 'shadow-[0_0_8px_rgba(251,191,36,0.9)]' },
  offline: { label: 'ROUTING',     dot: 'bg-[color:var(--text-faint)]', text: 'text-[color:var(--text-dim)]', ring: '' },
}

// TTLs are tuned to how fast each resource actually changes — see CACHE_POLICY.
//
// Exported because the day-scoped feeds need two lifetimes each — one for an open
// day, one for a closed one — and only the open figure can be advertised in an
// EndpointSpec. lib/daily-feed.ts reads both from here rather than restating them,
// so the manifest and the route cannot disagree about what a cache entry is worth.
export const TTL = {
  schedule:  604800,  // 1 week  — fixture lists are set months ahead
  teams:     604800,  // 1 week  — franchise structure is near-static
  standings: 86400,   // 1 day   — changes once per game day
  leaders:   86400,   // 1 day   — season aggregates move slowly
  depth:     43200,   // 12 h    — shifts across the practice week
  scores:    3600,    // 1 h     — final scores are immutable once posted
  injuries:  900,     // 15 min  — highest-churn pre-game signal
  pbp:       30,      // 30 s    — append-only during play
  freeAgents: 21600,  // 6 h     — a derived list; the signings themselves land in /transactions
  txnToday:  900,     // 15 min  — today's wire is still being written
  txnPast:   604800,  // 1 week  — a closed day's transaction log does not change
  changesToday: 300,  // 5 min   — the invalidation signal; stale here strands every other cache
} as const

const LIVE_TTL: Record<string, number> = {
  nba: 20, nhl: 30, nfl: 45, mlb: 30, wnba: 30, tennis: 60, mma: 120,
}

function core(sport: string, opts: { scores?: boolean; roster?: boolean } = {}): EndpointSpec[] {
  const list: EndpointSpec[] = [
    { path: 'schedule',  dataType: 'schedule',  params: ['season?'], ttl: TTL.schedule,
      desc: 'Full season fixture list', signal: 'Anchors every forward-looking market.' },
    { path: 'standings', dataType: 'standings', params: ['season?'], ttl: TTL.standings,
      desc: 'League standings', signal: 'Drives futures and win-total pricing.' },
  ]
  if (opts.scores !== false) {
    list.push({ path: 'scores', dataType: 'scores', params: ['date?'], ttl: TTL.scores,
      desc: 'Results for a given date', signal: 'Settlement source for completed markets.' })
  }
  if (opts.roster !== false) {
    list.push({ path: 'roster', dataType: 'roster', params: ['team_id'], ttl: TTL.schedule,
      desc: 'Team roster / profile', signal: 'Who is actually available to play.' })
  }
  list.push({
    path: 'live', dataType: 'live', params: ['game_id'], ttl: LIVE_TTL[sport] ?? 30,
    minTier: 'analyst',
    desc: 'Live game state', signal: 'In-play market pricing.',
  })
  return list
}

const INJURIES: EndpointSpec = {
  path: 'injuries', dataType: 'injuries', params: ['season?'], ttl: TTL.injuries,
  desc: 'Current injury report',
  signal: 'Highest-signal driver of line movement. A late scratch moves a total by points, not fractions.',
}

const TEAMS: EndpointSpec = {
  path: 'teams', dataType: 'teams', params: [], ttl: TTL.teams,
  desc: 'League hierarchy (conferences, divisions, teams)',
  signal: 'Resolves the team_id every other lookup needs.',
}

const PBP: EndpointSpec = {
  path: 'pbp', dataType: 'pbp', params: ['game_id'], ttl: TTL.pbp, minTier: 'analyst',
  desc: 'Play-by-play event stream',
  signal: 'The event feed in-play markets are repriced from, possession by possession.',
}

const LEADERS: EndpointSpec = {
  path: 'leaders', dataType: 'leaders', params: ['season?'], ttl: TTL.leaders,
  desc: 'Season statistical leaders',
  signal: 'Base rates for player-prop modelling.',
}

// ─── Roster movement ──────────────────────────────────────────────────────────
// /roster answers "who is on this team right now". These two answer the questions
// a market actually needs: what CHANGED, and who is still unsigned. A trade or a
// buyout reprices a team total before any injury report reflects it, and the
// transaction log carries the timestamp the move became effective — which is what
// decides whether a bet placed at 21:14 was placed into stale information.

const TRANSACTIONS: EndpointSpec = {
  path: 'transactions', dataType: 'transfers', params: ['date?'], ttl: TTL.txnToday,
  desc: 'Trades, signings, waivers and assignments effective on a date',
  signal: 'The first hard confirmation of a roster change. Every record carries '
        + 'transaction_type, effective_date, and from_team/to_team, so a move can be '
        + 'attributed and timestamped rather than inferred from a later box score. '
        + 'A day with no moves omits `players` entirely rather than returning an empty '
        + 'array — read it as `data.players ?? []`.',
}

const FREE_AGENTS: EndpointSpec = {
  path: 'free-agents', dataType: 'free_agents', params: [], ttl: TTL.freeAgents,
  desc: 'Unsigned players available league-wide',
  signal: 'The supply side of the transaction market — who a thin roster can still add.',
}

const CHANGE_LOG: EndpointSpec = {
  path: 'changes', dataType: 'changes', params: ['date?'], ttl: TTL.changesToday,
  desc: 'Which documents the upstream revised on a date',
  signal: 'Poll this instead of polling everything. It names the exact player, schedule, '
        + 'results and standings ids that moved, so a consumer refetches only what changed '
        + 'rather than re-pulling the league on a timer. Sections with no changes are '
        + 'omitted rather than returned empty.',
}

// ─── Resolution surface ───────────────────────────────────────────────────────
// Normalised settlement endpoints. Distinct from the pricing endpoints above:
// these return one shape across every sport so a market engine does not need to
// know which upstream answered. See lib/resolution.ts for the contract.

const EVENTS: EndpointSpec = {
  path: 'events', dataType: 'schedule', params: ['season?', 'from?', 'to?'], ttl: 86400,
  desc: 'Normalised event registry (id, name, scheduled time)',
  signal: 'The stable id a market binds to before the event happens.',
}

const RESOLVE: EndpointSpec = {
  path: 'resolve', dataType: 'results', params: ['event_id'], ttl: 300,
  desc: 'Normalised outcome with an explicit official/provisional flag',
  signal: 'Settlement source. Only settle when meta.settleable is true — it is computed per event, so an unfinished or unknown event returns false.',
}

// ─── Sportradar resolution surface ────────────────────────────────────────────
// EVENTS/RESOLVE for the seven Sportradar sports. Declared separately from the
// shared EVENTS/RESOLVE constants because the TTLs differ for a structural
// reason: these resolvers read a SHARED document (a season schedule, or a day's
// summaries) rather than a per-event one, so they cannot use the 30-day official
// promotion and instead depend on a short pending TTL to stay current. See the
// caching note in lib/resolve-dispatch.ts.
const SR_EVENTS: EndpointSpec = {
  ...EVENTS,
  desc: 'Normalised event registry (id, teams, scheduled time)',
  signal: 'The stable game id a market binds to before tip-off. For tennis and MMA '
        + 'the id carries its date, which makes later resolution a single read.',
}

const SR_RESOLVE: EndpointSpec = {
  ...RESOLVE,
  ttl: 300,
  signal: 'Settlement source. Sportradar publishes `complete` (played, stats unreviewed) '
        + 'and `closed` (stats final) as separate states; only `closed` reports '
        + 'official. Settle when meta.settleable is true, never on `complete`.',
}

type SportDecl = Omit<SportSpec, 'sources'>

const DECLARED: SportDecl[] = [
  {
    key: 'nba', label: 'NBA', entitled: true, status: 'online', statusNote: 'All endpoints live', capacity: 'high', teamBased: true, season: '2025',
    note: '/transactions is date-scoped — pass ?date=YYYY-MM-DD for a specific day. '
        + '/free-agents is a large league-wide document (~725KB); use ?limit= or ?fields= '
        + 'unless you genuinely need every unsigned player.',
    endpoints: [SR_EVENTS, SR_RESOLVE, ...core('nba'), INJURIES, LEADERS, TEAMS, PBP, TRANSACTIONS, FREE_AGENTS, CHANGE_LOG],
  },
  {
    key: 'nhl', label: 'NHL', entitled: true, status: 'online', statusNote: 'All endpoints live', capacity: 'high', teamBased: true, season: '2025',
    note: 'NHL/NFL/MLB nest the free-agent list under `league.free_agents`; NBA and WNBA '
        + 'return it at the top level. Verified against the live feed, not normalised — '
        + 'this is a pass-through surface.',
    endpoints: [SR_EVENTS, SR_RESOLVE, ...core('nhl'), INJURIES, LEADERS, TEAMS, PBP, TRANSACTIONS, FREE_AGENTS, CHANGE_LOG],
  },
  {
    key: 'nfl', label: 'NFL', entitled: true, status: 'online', statusNote: 'All endpoints live', capacity: 'high', teamBased: true, season: '2025',
    note: 'Injuries and depth charts are week-scoped — pass ?week=N. '
        + '/free-agents is very large here (~2.4MB, 8k+ players) and nests under '
        + '`league.free_agents` — pass ?limit= unless you need the whole list.',
    endpoints: [
      SR_EVENTS, SR_RESOLVE,
      ...core('nfl', { scores: false }),
      TRANSACTIONS, FREE_AGENTS, CHANGE_LOG,
      { ...INJURIES, params: ['season?', 'week?'] },
      { path: 'depth-chart', dataType: 'depth_charts', params: ['season?', 'week?'], ttl: TTL.depth,
        desc: 'Offensive/defensive depth chart',
        signal: 'Starter ordering drives snap counts, which drive nearly all NFL player props.' },
      TEAMS, PBP,
    ],
  },
  {
    key: 'mlb', label: 'MLB', entitled: true, status: 'online', statusNote: 'All endpoints live · in season', capacity: 'high', teamBased: true, season: '2026',
    note: 'Free agents nest under `league.free_agents` on this feed.',
    endpoints: [SR_EVENTS, SR_RESOLVE, ...core('mlb'), INJURIES, TEAMS, PBP, TRANSACTIONS, FREE_AGENTS, CHANGE_LOG],
  },
  {
    key: 'wnba', label: 'WNBA', entitled: true, status: 'online', statusNote: 'All endpoints live · in season', capacity: 'medium', teamBased: true, season: '2026',
    endpoints: [SR_EVENTS, SR_RESOLVE, ...core('wnba'), INJURIES, TEAMS, PBP, TRANSACTIONS, FREE_AGENTS, CHANGE_LOG],
  },
  {
    key: 'tennis', label: 'Tennis', entitled: true, status: 'online', statusNote: 'All endpoints live · in season', capacity: 'high', teamBased: false, season: '2026',
    note: 'Individual sport — /standings returns ATP/WTA rankings. No roster or teams.',
    endpoints: [
      { path: 'schedule',  dataType: 'schedule',  params: ['date?'], ttl: TTL.scores,
        desc: 'Match summaries for a date', signal: 'Draw and match slate.' },
      // 3h, not the 1h default — a tennis day's results settle slowly and
      // re-fetching a completed slate is pure quota burn.
      { path: 'scores',    dataType: 'scores',    params: ['date?'], ttl: 10800,
        desc: 'Match results for a date', signal: 'Settlement source.' },
      { path: 'standings', dataType: 'rankings',  params: [], ttl: TTL.standings,
        desc: 'ATP / WTA rankings', signal: 'Primary seeding input for match pricing.' },
      { path: 'live',      dataType: 'live',      params: [], ttl: LIVE_TTL.tennis, minTier: 'analyst',
        desc: 'All in-progress matches', signal: 'In-play pricing.' },
    ],
  },
  {
    key: 'mma', label: 'MMA', entitled: true, status: 'limited', statusNote: 'Event-based coverage — fight weeks only', capacity: 'low', teamBased: false, season: '2026',
    note: 'Individual sport. Events are scheduled in weekly cards.',
    endpoints: [
      // 6h, matching /scores below. This was TTL.scores (1h), which meant the
      // hourly warm job re-fetched a weekly fight card 24 times a day: 448 of
      // MMA's 2,500 monthly calls went on warming alone in August 2026, with no
      // client traffic behind them. A card does not change hourly.
      { path: 'schedule', dataType: 'schedule', params: ['date?'], ttl: 21600,
        desc: 'Event summaries for a date', signal: 'Fight card slate.' },
      // 6h — MMA runs weekly cards, so a results document is static almost all
      // of the time and the monthly quota here is only 2,500 calls.
      { path: 'scores',   dataType: 'scores',   params: ['date?'], ttl: 21600,
        desc: 'Event results', signal: 'Settlement source.' },
      { path: 'live',     dataType: 'live',     params: [], ttl: LIVE_TTL.mma, minTier: 'analyst',
        desc: 'In-progress events', signal: 'Between-round in-play pricing.' },
    ],
  },
  {
    key: 'nascar', label: 'NASCAR', entitled: false, status: 'offline', statusNote: 'Integrating soon', capacity: 'none', teamBased: false, season: '2026',
    note: 'Not available on the current plan — requests return 403.',
    endpoints: [],
  },
  {
    key: 'nba_gleague', label: 'NBA G League', entitled: false, status: 'offline', statusNote: 'Integrating soon', capacity: 'none', teamBased: true, season: '2025',
    note: 'Not available on the current plan — requests return 403.',
    endpoints: [],
  },
  {
    key: 'soccer', label: 'Soccer', entitled: true, status: 'online',
    statusNote: 'World Cup + Friendlies · Merkle-verifiable', capacity: 'high', teamBased: true, season: '2026',
    note: 'Served from TxLINE (TxODDS), which anchors every fixture, odds and score '
        + 'update to Solana — /verify returns the Merkle proof for a settlement. '
        + 'Current entitlement covers World Cup and international Friendlies only; '
        + 'domestic league depth needs a higher subscription tier.',
    endpoints: [
      EVENTS,
      RESOLVE,
      { path: 'schedule', dataType: 'schedule', params: ['date?'], ttl: 3600,
        desc: 'Fixture list from a given day', signal: 'The slate markets are opened against.' },
      { path: 'scores',   dataType: 'scores',   params: ['fixture_id'], ttl: 60,
        desc: 'Score event snapshots for a fixture', signal: 'Raw in-play event feed.' },
      { path: 'odds',     dataType: 'odds',     params: ['fixture_id'], ttl: 60, minTier: 'analyst',
        desc: 'Latest odds for a fixture', signal: 'Market consensus pricing.' },
      // stat_keys is REQUIRED, not optional: the proof is scoped to the specific
      // statistic being settled, and our upstream template interpolates it. It was
      // advertised optional, so a caller omitting it got a confusing upstream
      // param error. Defaulting it would be worse than erroring — a Merkle proof
      // for a stat you are not settling on is a proof of the wrong thing.
      { path: 'verify',   dataType: 'validation', params: ['fixture_id', 'seq', 'stat_keys'], ttl: 86400, minTier: 'analyst',
        desc: 'Merkle proof for one score update (pass the settled_seq from /resolve)',
        signal: 'Lets a counterparty verify a settlement independently, on-chain.' },
    ],
  },
  {
    key: 'football', label: 'Football (Bundesliga)', entitled: false, status: 'offline',
    statusNote: 'Integrating soon', capacity: 'high', teamBased: true, season: '2025',
    note: 'OpenLigaDB is fully open and keyless, but German-league-first by design: '
        + 'Bundesliga, 2. Bundesliga and DFB-Pokal, not EPL or La Liga. Registered so the '
        + 'routing is visible, and left offline until the endpoints are verified and a '
        + 'resolution mapper exists for its response shape.',
    endpoints: [
      { path: 'schedule',  dataType: 'schedule',  params: ['league', 'season?'], ttl: TTL.schedule,
        desc: 'Matchday fixtures and results', signal: 'Fixtures and outcomes arrive in one document.' },
      { path: 'standings', dataType: 'standings', params: ['league', 'season?'], ttl: TTL.standings,
        desc: 'League table', signal: 'Settles title and relegation markets.' },
      { path: 'teams',     dataType: 'teams',     params: ['league', 'season?'], ttl: TTL.teams,
        desc: 'Clubs in a competition', signal: 'Resolves the club ids other lookups need.' },
    ],
  },
  {
    key: 'f1', label: 'Formula 1', entitled: true, status: 'online',
    statusNote: 'Open sources · resolution surface', capacity: 'high', teamBased: false, season: '2026',
    note: 'Served from open community sources. Scoped to prediction-market '
        + 'resolution: /resolve settles on the official FIA classification via Jolpica-F1, '
        + 'while /live carries provisional OpenF1 timing that must NOT be settled on. '
        + 'Telemetry, team radio and weather are pricing signals and are deliberately out of scope.',
    endpoints: [
      EVENTS,
      RESOLVE,
      { path: 'schedule',   dataType: 'schedule',   params: ['season?'], ttl: TTL.schedule,
        desc: 'Season race calendar', signal: 'Raw round list and dates.' },
      { path: 'standings',  dataType: 'standings',  params: ['season?'], ttl: TTL.standings,
        desc: "Drivers' championship standings", signal: 'Settles championship markets.' },
      { path: 'qualifying', dataType: 'qualifying', params: ['season?', 'round'], ttl: TTL.standings,
        desc: 'Qualifying classification', signal: 'Settles pole and qualifying markets.' },
      { path: 'live',       dataType: 'position',   params: ['session_key?'], ttl: 20, minTier: 'analyst',
        desc: 'Provisional live running order (OpenF1)',
        signal: 'In-play pricing only — provisional, never a settlement source.' },
    ],
  },

  // ─── Esports ────────────────────────────────────────────────────────────────
  //
  // Every title below is registered. Two of them serve data, and that ratio is
  // the honest state of open-source esports rather than a build gap.
  //
  // Note WHICH two, because it is the whole argument: Dota 2, where the publisher
  // happens to expose a WebAPI, and Agent Fighter, whose operator publishes a
  // results API deliberately. Coverage tracks publisher willingness exactly, and
  // nothing else.
  //
  // The constraint is licensing, not engineering. Match-level esports results are
  // published by the game publishers, and none of them permit redistribution:
  // Riot will not issue production keys for a resale service, Valve is the
  // exception (its WebAPI feeds OpenDota under MIT), and everyone else has no
  // public feed at all. The community wiki that covers the remaining titles —
  // Liquipedia — was probed directly and does not carry placement-to-team data in
  // any form we can parse under an open licence; see providers/liquipedia.ts for
  // the exact wikitext that was checked and why it fails.
  //
  // Registering the unavailable titles is deliberate. `/api/v1/lol` returning a
  // 403 that names Riot's policy is a better answer than a 404 that looks like we
  // forgot, and it is the same argument providers/types.ts makes for `offline`
  // being a first-class provider state.
  {
    key: 'dota2', label: 'Dota 2', entitled: true, status: 'online', group: 'esports',
    statusNote: 'Match-level resolution · settleable',
    capacity: 'high', teamBased: true, season: '2026',
    // Promoted from 'limited' on 2026-09-02. The previous caveat was that OpenDota
    // returned HTTP 522 throughout the original build, so the field mapping came
    // from documented schema rather than an observed response.
    //
    // The promotion check this file specified has now been run against the live
    // API: GET https://api.opendota.com/api/proMatches returned 200 with 100 rows,
    // and the first row carried match_id, radiant_win, radiant_name, dire_name,
    // radiant_score, dire_score, start_time, duration, leagueid, series_id and
    // series_type — every field providers/opendota.ts reads, with the documented
    // types. Production has also been warming dota2:schedule:pro hourly without
    // error, so this is observed behaviour and not a one-off probe.
    note: 'The only esports title with an open, redistributable, match-level feed. '
        + 'Served from OpenDota (MIT), whose `radiant_win` originates in the Valve WebAPI — '
        + 'the publisher\'s own record, which is what makes it settleable. '
        + 'A completed match reports `provisional` for 6 hours before it goes official, '
        + 'because replays can be re-parsed and technical remakes exist. '
        + 'IMPORTANT: match ids are PER GAME, not per series — a Bo3 market must aggregate '
        + 'the games sharing a series_id. /resolve says so in `notes` when it applies.',
    endpoints: [
      // TTLs are overridden from the shared specs, and MUST stay that way.
      //
      // The shared EVENTS ttl (1 day) suits a season calendar fixed months ahead.
      // Dota 2's registry is /proMatches — a rolling window of the ~100 most recent
      // professional matches. At a day-long TTL the warm job would write the entry
      // once and then skip it as fresh for 24 hours, so a match that ended minutes
      // ago would never appear and every settlement would fall through to a
      // per-match fetch. lib/resolve-dispatch.ts reads these via ttlFor() rather
      // than declaring its own copy, so the two cannot drift apart.
      { ...EVENTS,  ttl: 300 },
      { ...RESOLVE, ttl: 600 },
      { path: 'live', dataType: 'live', params: [], ttl: 60, minTier: 'analyst',
        desc: 'In-progress professional matches',
        signal: 'In-play pricing only — a live match has no winner and is never settleable.' },
    ],
  },

  {
    key: 'agentfighter', label: 'Agent Fighter', entitled: true, status: 'online', group: 'esports',
    statusNote: 'Open results API · winners derived by deterministic re-simulation',
    capacity: 'high', teamBased: false, season: '2026',
    // 'online', and unlike dota2 that is not a hedge: every endpoint below was
    // probed live and returned 200 with the documented shape. The upstream also
    // publishes an OpenAPI 3.1 spec, so the field names are contractual rather
    // than observed.
    note: 'A deterministic browser fighting game where humans and AI agents share one arena, '
        + 'and the only esports title here whose operator publishes its own results API. '
        + 'The winner of a ranked match is DERIVED, not reported: the server re-simulates the '
        + "match's full input ledger from tick 0 on a fixed-point engine, and publishes the final "
        + 'state hash so a counterparty can replay the inputs and check the result independently. '
        + 'Settlement is gated on `resolution.settlement` alone — final settles, void refunds, '
        + 'provisional never settles. There is no confirmation window because the upstream states '
        + 'the settled/unsettled distinction directly rather than leaving it to be inferred. '
        + 'THREE THINGS TO ENCODE: (1) a forfeit is reported as a DECIDED WIN, because leaving a '
        + 'wager loses it by design here — void it under your own rules if you want to, this API '
        + 'will not do it for you; (2) `verified: false` means the win was awarded because a side '
        + 'vanished rather than by replaying the ledger, so the determinism guarantee does not '
        + 'cover that row; (3) /events lists RATED WAGERS ONLY — the platform runs far more arcade '
        + 'practice than wagers, so an unfiltered registry would be almost all material no market '
        + 'would price. /resolve still resolves any match id, rated or not. '
        + 'Seasons are 21-day cycles numbered from 1; `season` on each event carries the real one.',
    endpoints: [
      // Overridden from the shared specs for the same reason dota2 overrides
      // them: these are rolling feeds, not season documents fixed months ahead.
      // The shared 1-day EVENTS ttl would leave a match that settled minutes ago
      // invisible to /events for 24 hours. resolve-dispatch.ts reads both via
      // ttlFor() rather than keeping its own copy, so they cannot drift.
      { ...EVENTS,  ttl: 300,
        desc: 'Recently settled rated wagers (id, players, time)',
        signal: 'The registry a market binds to. NOTE: this feed is settled-only — Agent Fighter '
              + 'publishes no forward schedule, so a market must be opened from outside this API '
              + 'and bound to a match id after the fact.' },
      { ...RESOLVE, ttl: 300 },
      { path: 'standings', dataType: 'standings', params: [], ttl: 900,
        desc: 'Season Elo ladder with computed ranks',
        signal: 'Settles season-ladder and finishing-position markets. Rated players only, which '
              + 'is the real ladder — legitimately empty early in a season, before anyone has '
              + 'played a rated match. Use /leaders for a populated roster.' },
      { path: 'leaders', dataType: 'leaders', params: [], ttl: 900,
        desc: 'Ranked roster with records and lifetime + season Elo',
        signal: 'Base rates for head-to-head pricing. Carries win rate, level and both Elo pools, '
              + 'and flags whether each competitor is a human or an AI agent.' },
    ],
  },

  // ── Publisher-locked (Riot) ─────────────────────────────────────────────────
  ...(['lol', 'valorant', 'tft'] as const).map(key => ({
    key,
    label: { lol: 'League of Legends', valorant: 'Valorant', tft: 'Teamfight Tactics' }[key],
    entitled: false, status: 'offline' as const, group: 'esports' as const,
    statusNote: 'Publisher-locked — no licensable source',
    capacity: 'none' as const, teamBased: key !== 'tft', season: '2026',
    note: 'Riot does not issue production API keys for redistribution services, public '
        + 'products may not run on development keys, and professional match results are not '
        + 'exposed by the public developer API at all. There is no open alternative. '
        + 'This gap is publisher-imposed and is not expected to close.',
    endpoints: [],
  })),

  // ── Wiki-only titles ────────────────────────────────────────────────────────
  // Liquipedia is the sole candidate source and is registered offline, so these
  // inherit that. They are the titles that would light up first if the LPDB
  // licensing or the rendered-HTML path is ever resolved.
  ...([
    ['cs2',          'Counter-Strike 2',   'counterstrike'],
    ['starcraft2',   'StarCraft II',       'starcraft2'],
    ['rocketleague', 'Rocket League',      'rocketleague'],
    ['overwatch',    'Overwatch 2',        'overwatch'],
    ['rainbow6',     'Rainbow Six Siege',  'rainbowsix'],
    ['cod',          'Call of Duty',       'callofduty'],
    ['mlbb',         'Mobile Legends',     'mobilelegends'],
  ] as const).map(([key, label, wiki]) => ({
    key, label,
    entitled: false, status: 'offline' as const, group: 'esports' as const,
    statusNote: 'No open match-level source',
    capacity: 'none' as const, teamBased: true, season: '2026',
    note: `No publisher API permits redistribution for this title. The Liquipedia `
        + `"${wiki}" wiki is the only candidate source and is registered OFFLINE: its `
        + `tournament wikitext carries prize structure but no team attribution, so `
        + `placements cannot be parsed from it. Tournament-level resolution only, if ever — `
        + `match-level is not available from any open source.`,
    endpoints: [],
  })),

  // ── Battle royale ───────────────────────────────────────────────────────────
  ...([
    ['apex',     'Apex Legends', 'apexlegends'],
    ['pubg',     'PUBG',         'pubg'],
    ['fortnite', 'Fortnite',     'fortnite'],
  ] as const).map(([key, label, wiki]) => ({
    key, label,
    entitled: false, status: 'offline' as const, group: 'esports' as const,
    statusNote: 'No open source · placement-scored format',
    capacity: 'none' as const, teamBased: true, season: '2026',
    note: `Same source problem as the other wiki-only titles (Liquipedia "${wiki}", `
        + `registered offline). Worth noting the FORMAT is not the blocker: battle royale `
        + `scores by placement plus kill points, which the existing resolution contract `
        + `already models — position carries the placement and points the score. If a `
        + `source appears, no contract change is needed.`,
    endpoints: [],
  })),
]

/**
 * Sports with provenance attached. Derived rather than declared so the advertised
 * source can never disagree with the router that actually serves the request.
 */
export const SPORTS: SportSpec[] = DECLARED.map(s => ({ ...s, sources: sourceRefs(s.key) }))

export const ENTITLED_SPORTS = SPORTS.filter(s => s.entitled)

export const SPORT_KEYS = SPORTS.map(s => s.key)

export function getSport(key: string): SportSpec | undefined {
  return SPORTS.find(s => s.key === key.toLowerCase())
}

// ─── Ordering and badges ──────────────────────────────────────────────────────
// Both derived from the manifest for the same reason `sources` is: the panel used
// to render SPORTS in declaration order, which is authoring history, not meaning.
// With 25 sports and 14 of them registered-but-offline, declaration order buries
// the ones that actually serve among the ones that don't.
//
// Kept here rather than in the component so the landing page, the dashboard and
// anything built later sort and label identically.

export type SportGroup = 'traditional' | 'esports'

export const groupOf = (s: SportSpec): SportGroup => s.group ?? 'traditional'

/**
 * Coverage verticals — the tabs on the public panel.
 *
 * A superset of SportGroup: every sport belongs to a group, but a vertical can be
 * announced before any sport exists for it. `politics` is exactly that case, so it
 * carries no SportSpec and `groupedSports` never yields it.
 *
 * Kept in the manifest rather than the component for the same reason as everything
 * else here — the tab list, its copy and its availability are product facts, and a
 * component that hardcoded them would drift the moment a vertical ships.
 */
export type Vertical = SportGroup | 'politics'

export interface VerticalMeta {
  label: string
  blurb: string
  /** False = announced, not serving. The tab renders a placeholder instead of rows. */
  available: boolean
  /** Shown on an unavailable vertical. What it will cover, and what is missing. */
  soon?: string
}

export const VERTICAL_META: Record<Vertical, VerticalMeta> = {
  traditional: {
    label: 'Sports',
    blurb: 'Licensed and open feeds. Settlement where a governing body publishes one.',
    available: true,
  },
  esports: {
    label: 'Esports',
    blurb: 'Open sources only. Match-level coverage is publisher-gated — most titles are '
         + 'registered to show what exists and why it is not served.',
    available: true,
  },
  politics: {
    label: 'Politics',
    blurb: 'Election and referendum resolution.',
    available: false,
    // Deliberately concrete about the hard part. Politics is the vertical where
    // "who won" is contested by design — the data problem is not fetching a
    // number, it is deciding which body's number is authoritative and when it
    // stops changing. That is the same `authoritative` / `official` contract the
    // resolution surface already enforces, which is why it belongs here at all.
    soon: 'Planned: official results from electoral commissions, resolved through the same '
        + '/events and /resolve contract the sports verticals use. The open question is '
        + 'provenance — certification timelines vary by jurisdiction and a called race is '
        + 'not a certified one, so nothing ships until a source can be marked authoritative '
        + 'without hand-waving.',
  },
}

/** Tab order. Available verticals first is deliberate — a placeholder should not lead. */
export const VERTICALS: Vertical[] = ['traditional', 'esports', 'politics']

/** Serving first, then degraded, then not serving. */
export const STATUS_RANK: Record<SportStatus, number> = { online: 0, limited: 1, offline: 2 }

export type StatusResolver = (s: SportSpec) => SportStatus

/**
 * Ordering within a group.
 *
 * Status leads because "can I use this today" is the first question. Endpoint
 * count breaks the tie ahead of the label so a sport with a real surface outranks
 * one with a token endpoint, and the label is the final tiebreak so the order is
 * stable across renders rather than depending on array position.
 */
export function compareSports(
  a: SportSpec,
  b: SportSpec,
  statusOf: StatusResolver = s => s.status
): number {
  const byStatus = STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]
  if (byStatus) return byStatus
  // Entitlement is a separate axis from status: a sport can be entitled and
  // degraded, or unentitled and merely unreachable. Entitled wins the tie.
  if (a.entitled !== b.entitled) return a.entitled ? -1 : 1
  const byEndpoints = b.endpoints.length - a.endpoints.length
  if (byEndpoints) return byEndpoints
  return a.label.localeCompare(b.label)
}

export interface SportGroupView {
  group:  SportGroup
  label:  string
  blurb:  string
  sports: SportSpec[]
  counts: Record<SportStatus, number>
  /** Serving = online + limited. The figure the tab badge shows. */
  serving: number
}

/**
 * SPORTS split into ordered sections.
 *
 * `statusOf` lets a caller substitute measured health for declared status — the
 * landing page passes live probe results — so the ordering reflects what is
 * actually happening, not what the manifest hoped.
 */
export function groupedSports(statusOf: StatusResolver = s => s.status): SportGroupView[] {
  return (['traditional', 'esports'] as const).map(group => {
    const sports = SPORTS.filter(s => groupOf(s) === group)
                         .sort((a, b) => compareSports(a, b, statusOf))
    const counts = { online: 0, limited: 0, offline: 0 } as Record<SportStatus, number>
    for (const s of sports) counts[statusOf(s)]++
    const { label, blurb } = VERTICAL_META[group]
    return { group, label, blurb, sports, counts, serving: counts.online + counts.limited }
  })
}

/**
 * Card indicators.
 *
 * Every badge answers a question a consumer would otherwise have to expand the
 * row and read prose to answer. All are derived — nothing here is hand-written
 * per sport, so a badge cannot claim something the endpoint table contradicts.
 */
export type BadgeTone = 'settle' | 'live' | 'open' | 'licensed' | 'caution'

export interface Badge {
  label: string
  tone:  BadgeTone
  title: string
}

export function badgesFor(sport: SportSpec): Badge[] {
  const out: Badge[] = []
  const has = (path: string) => sport.endpoints.some(e => e.path === path)
  const def = sport.sources.find(s => s.isDefault)

  // The headline capability of this product. Requires BOTH a normalised
  // settlement endpoint and a default source permitted to mark a result official
  // — a /resolve backed by a non-authoritative source can only ever return
  // provisional, and badging that as settleable would be the single most
  // damaging thing this panel could get wrong.
  if (has('resolve') && def?.authoritative) {
    out.push({
      label: 'SETTLES',
      tone:  'settle',
      title: `Market settlement via /resolve, sourced from ${def.label}. `
           + 'Returns an explicit official flag — settle only when it is true.',
    })
  }

  if (has('live')) {
    out.push({
      label: 'IN-PLAY',
      tone:  'live',
      title: 'Live in-play feed. Analyst tier and above. Never a settlement source.',
    })
  }

  // Licence posture, but only for a sport that actually serves.
  //
  // On an unentitled sport this describes a source we are not routing to, and an
  // "OPEN" chip beside a ROUTING light reads as availability — the opposite of
  // the truth. The information is not lost: the expanded SOURCE row renders the
  // full posture for every source including offline ones.
  //
  // The 'licensed' case emits no badge on purpose — naming a commercial data
  // relationship on the public card exposes a supplier detail with no consumer
  // value, so licensed sources simply carry their provider badge and nothing more.
  if (def && sport.entitled) {
    if (def.license === 'open') {
      out.push({ label: 'OPEN', tone: 'open',
        title: `${def.attribution}. Open licence — no per-call cost to us.` })
    } else if (def.license === 'unclear') {
      out.push({ label: 'UNVERIFIED TERMS', tone: 'caution',
        title: `${def.label} publishes no terms permitting resale — free tier only.` })
    }
  }

  // Small monthly allocation. The gateway already throttles these harder
  // (SCARCE_RPM in gateway.ts); saying so up front beats a surprise 429.
  if (sport.entitled && sport.capacity === 'low') {
    out.push({ label: 'SCARCE', tone: 'caution',
      title: 'Small upstream allocation — rate limited more tightly. Poll conservatively.' })
  }

  return out
}

// ─── Derived lookups ──────────────────────────────────────────────────────────
// Routes ask these questions instead of carrying their own hardcoded SUPPORTED
// arrays and TTL constants. One manifest, so adding a sport cannot leave a stale
// whitelist behind in a route nobody remembered to update.

export function getEndpoint(sport: string, path: string): EndpointSpec | undefined {
  return getSport(sport)?.endpoints.find(e => e.path === path)
}

/** Which sports expose a given endpoint. Replaces the per-route SUPPORTED lists. */
export function supportedFor(path: string): string[] {
  return SPORTS.filter(s => s.entitled && s.endpoints.some(e => e.path === path)).map(s => s.key)
}

export function supports(sport: string, path: string): boolean {
  return !!getEndpoint(sport, path)
}

export function ttlFor(sport: string, path: string, fallback: number): number {
  return getEndpoint(sport, path)?.ttl ?? fallback
}

/**
 * The MCP tool catalog, derived from the endpoint manifest.
 *
 * One tool per distinct endpoint path across all entitled sports. Both the MCP
 * route and the landing page read this, so the advertised tool list cannot drift
 * from the tools that actually exist — it previously did, in both directions.
 */
export interface ToolRef {
  name: string
  path: string
  spec: EndpointSpec
}

export function toolCatalog(): ToolRef[] {
  const byPath = new Map<string, EndpointSpec>()
  for (const sport of ENTITLED_SPORTS) {
    for (const e of sport.endpoints) if (!byPath.has(e.path)) byPath.set(e.path, e)
  }
  return [...byPath.entries()].map(([path, spec]) => ({
    name: `get_${path.replace(/-/g, '_')}`,
    path,
    spec,
  }))
}

/** Upstream backing a specific endpoint, for per-row attribution in the UI. */
export function endpointSource(sport: string, path: string): SourceRef | undefined {
  const spec = getEndpoint(sport, path)
  if (!spec) return undefined
  const p = resolveProvider(sport, spec.dataType)
  return p && toSourceRef(p, true)
}

/**
 * Every upstream a sport can be routed to, for the `?provider=` picker.
 * Default first, then alternates — including offline ones, which are published
 * deliberately so an integrator can see what exists before it is switched on.
 */
export function providerOptions(sport: string): SourceRef[] {
  return sourceRefs(sport)
}

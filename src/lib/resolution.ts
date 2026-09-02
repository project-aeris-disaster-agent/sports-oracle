// src/lib/resolution.ts
// The normalised settlement contract.
//
// This is the one place normalisation earns its keep. The pricing surface stays
// raw pass-through — normalising six vendors' schemas is a tar pit — but the
// resolution slice is ~10 fields, genuinely common across sports, and it IS the
// product. A market engine should not need to know whether F1 came from Jolpica
// or basketball came from Sportradar.
//
// ─── The boundary that keeps this small ──────────────────────────────────────
// This layer exposes FACTS, not SETTLEMENTS. It reports that driver 44 finished
// with position=15, position_text="R", laps=32, grid=8. It does NOT decide
// whether a head-to-head market voids. That belongs to the market layer, and
// keeping it there means new market types ship without touching the data layer.
//
// ─── Standard F1 settlement rules the market layer should apply ──────────────
// Documented here because the fields below were chosen to support exactly these:
//
//   Head-to-head (driver matchup)
//     · Both classified            -> higher `position` wins
//     · One retires, one classified -> the classified driver WINS.
//                                      A DNF loses. It does NOT void.
//     · Both retire                -> more `laps` wins
//     · Both retire, equal laps    -> void
//     · Either driver `started` = false -> void
//     · Disqualification           -> a loss, not a void
//
//   Podium / points finish
//     · Settle on `position`, never on "crossed the line". Under the FIA 90%
//       rule a driver who retired late is still classified and still scores.
//       A retired driver can legitimately win a points-finish market.
//
//   Finality
//     · Settle only when `official` is true. A provisional source reports the
//       order seconds after the flag; it knows nothing about the penalty applied
//       ninety minutes later. See `authoritative` in providers/types.ts.

import type { ProviderId } from '@/lib/providers'

/**
 * Sports with a normalised resolution mapper, in the order they were added.
 *
 * Every sport still serves raw pass-through data; this is the subset whose
 * outcomes have been mapped to the settlement contract below. Adding one means
 * writing a mapper, not touching the routes.
 *
 * Kept as a literal rather than derived from RESOLVERS because resolve-dispatch
 * imports this module: reading it back would be circular. The pairing is covered
 * by assertResolvableMatchesResolvers() in resolve-dispatch.ts, which fails loudly
 * at module load if the two ever disagree, so the duplication cannot rot silently.
 */
export const RESOLVABLE = [
  'f1', 'soccer', 'dota2', 'agentfighter',
  'nba', 'nhl', 'wnba', 'nfl', 'mlb', 'tennis', 'mma',
]

export type ResolutionStatus =
  | 'scheduled'    // event exists, has not started
  | 'live'         // in progress
  | 'provisional'  // outcome known, not yet official — DO NOT SETTLE
  | 'official'     // settleable
  | 'void'         // no result will be produced

export type VoidReason =
  | 'postponed'
  | 'cancelled'
  | 'abandoned'
  | 'walkover'
  | 'no_contest'

export interface Competitor {
  competitor_id: string
  name:          string
  /** Constructor / team / club. Null for genuinely individual competitors. */
  team_id:       string | null
  team:          string | null

  /**
   * Official classification position. THIS is the settlement key — retired
   * drivers are already slotted into this order by distance completed, which is
   * exactly the standard head-to-head tiebreak.
   */
  position:      number | null
  /** Raw upstream code: a number, or R/D/E/W/F/N. Distinguishes DNF from DSQ. */
  position_text: string
  /** Human reason: "Finished", "+1 Lap", "Collision", "Gearbox". */
  status:        string

  /** Took the chequered flag. False for any retirement, including a classified one. */
  finished:      boolean
  /**
   * Started the event. False voids a head-to-head.
   *
   * TRAP: grid = 0 means a PIT LANE START, not a DNS. A driver on grid 0 did
   * start and their markets stand. Never infer DNS from grid position.
   */
  started:       boolean

  laps:          number | null
  grid:          number | null
  points:        number | null
}

export interface Resolution {
  event_id:     string
  sport:        string
  name:         string
  season:       string
  round:        string | null

  status:       ResolutionStatus
  scheduled_at: string | null

  competitors:  Competitor[]
  winner_id:    string | null
  winner:       string | null

  /** True only from an authoritative source. Never settle on false. */
  official:     boolean
  void_reason:  VoidReason | null

  // ─── Provenance. A settlement dispute is answerable from these three fields.
  source:        ProviderId
  authoritative: boolean
  observed_at:   string
  finalized_at:  string | null

  /** Operator-facing warnings, e.g. an in-progress stewards' investigation. */
  notes:        string[]

  /**
   * Upstream sequence number the settlement was read from, where the provider
   * exposes one. TxLINE's Merkle proofs are scoped to a single score update, so
   * verifying a settlement on-chain requires the exact seq it came from.
   */
  settled_seq?: number
}

// ─── Jolpica (Ergast schema) ─────────────────────────────────────────────────

interface ErgastDriver      { driverId: string; givenName: string; familyName: string; code?: string }
interface ErgastConstructor { constructorId: string; name: string }
interface ErgastResult {
  position:     string
  positionText: string
  points:       string
  grid:         string
  laps:         string
  status:       string
  Driver:       ErgastDriver
  Constructor:  ErgastConstructor
}
interface ErgastRace {
  season:   string
  round:    string
  raceName: string
  date?:    string
  time?:    string
  Results?: ErgastResult[]
  SprintResults?: ErgastResult[]
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function racesOf(payload: unknown): ErgastRace[] {
  const mr = (payload as { MRData?: { RaceTable?: { Races?: ErgastRace[] } } })?.MRData
  return mr?.RaceTable?.Races ?? []
}

/** Ergast codes for a competitor that never took the start. */
const DNS_CODES = new Set(['W', 'F', 'N'])

function mapErgastResult(r: ErgastResult): Competitor {
  const positionText = r.positionText ?? ''
  const finished     = /^\d+$/.test(positionText)
  const statusText   = r.status ?? ''

  return {
    competitor_id: r.Driver?.driverId ?? '',
    name:          [r.Driver?.givenName, r.Driver?.familyName].filter(Boolean).join(' '),
    team_id:       r.Constructor?.constructorId ?? null,
    team:          r.Constructor?.name ?? null,

    position:      num(r.position),
    position_text: positionText,
    status:        statusText,

    finished,
    // Deliberately does NOT consult grid — grid 0 is a pit lane start.
    started:       !DNS_CODES.has(positionText) && !/did not start/i.test(statusText),

    laps:          num(r.laps),
    grid:          num(r.grid),
    points:        num(r.points),
  }
}

export function fromJolpica(
  sport: string,
  payload: unknown,
  opts: { sprint?: boolean } = {}
): Resolution | null {
  const race = racesOf(payload)[0]
  if (!race) return null

  const raw = (opts.sprint ? race.SprintResults : race.Results) ?? []
  const competitors = raw.map(mapErgastResult)

  const scheduledAt = race.date
    ? new Date(`${race.date}T${race.time ?? '00:00:00Z'}`).toISOString()
    : null

  // Jolpica publishes a classification only once it is official — scrutineering
  // and stewards' decisions are already reflected. Absence of results therefore
  // means "not yet", never "void": a cancelled race simply never appears, and
  // inventing a void from missing data would settle markets that should stand.
  const hasResults = competitors.length > 0
  const winner     = competitors.find(c => c.position === 1) ?? null

  return {
    event_id:     `${race.season}-${race.round}${opts.sprint ? '-sprint' : ''}`,
    sport,
    name:         opts.sprint ? `${race.raceName} (Sprint)` : race.raceName,
    season:       race.season,
    round:        race.round ?? null,

    status:       hasResults ? 'official' : 'scheduled',
    scheduled_at: scheduledAt,

    competitors,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,

    official:     hasResults,
    void_reason:  null,

    source:        'jolpica',
    authoritative: true,
    observed_at:   new Date().toISOString(),
    finalized_at:  hasResults ? new Date().toISOString() : null,
    notes:         [],
  }
}

/** Event registry from the Jolpica season calendar. */
export interface EventRef {
  event_id:     string
  sport:        string
  name:         string
  season:       string
  round:        string | null
  scheduled_at: string | null
  source:       ProviderId
}

export function eventsFromJolpica(sport: string, payload: unknown): EventRef[] {
  return racesOf(payload).map(race => ({
    event_id:     `${race.season}-${race.round}`,
    sport,
    name:         race.raceName,
    season:       race.season,
    round:        race.round ?? null,
    scheduled_at: race.date
      ? new Date(`${race.date}T${race.time ?? '00:00:00Z'}`).toISOString()
      : null,
    source:       'jolpica' as ProviderId,
  }))
}

// ─── TxLINE soccer ───────────────────────────────────────────────────────────
//
// Documented fixture-status codes. Verified against live data 2026-07-25.
const SOCCER_STATUS: Record<number, string> = {
  1: 'NS', 2: 'H1', 3: 'HT', 4: 'H2', 5: 'F', 6: 'WET', 7: 'ET1', 8: 'HTET',
  9: 'ET2', 10: 'FET', 11: 'WPE', 12: 'PE', 13: 'FPE', 14: 'I', 15: 'A',
  16: 'C', 17: 'TXCC', 18: 'TXCS', 19: 'P',
}

/** Match is over and the result stands. F / FET / FPE. */
const SOCCER_TERMINAL = new Set([5, 10, 13])

/** No result will be produced. Maps to a void_reason below. */
const SOCCER_VOID: Record<number, VoidReason> = {
  15: 'abandoned',
  16: 'cancelled',
  17: 'cancelled',   // TX coverage cancelled
  19: 'postponed',
}

/**
 * UNDOCUMENTED but load-bearing. Every played fixture we sampled (9/9 with score
 * data) carries an Action of `game_finalised` with StatusId 100, and it is the
 * only reliable end-of-match marker — several matches never emit a documented
 * terminal status at all. It is absent from the published status table, so treat
 * it as an observed behaviour that could change, not a contract.
 */
const SOCCER_FINALISED = 100

interface TxScoreTotals { Goals?: number; Corners?: number; YellowCards?: number; RedCards?: number }
interface TxScoreSide   { Total?: TxScoreTotals; HT?: TxScoreTotals; ETTotal?: TxScoreTotals }
interface TxScoreEvent {
  FixtureId:  number
  Seq:        number
  Ts?:        number
  Action?:    string
  StatusId?:  number
  Confirmed?: boolean
  StartTime?: number
  Participant1Id?: number
  Participant2Id?: number
  Participant1IsHome?: boolean
  Score?: { Participant1?: TxScoreSide; Participant2?: TxScoreSide }
}

export interface SoccerFixtureRef {
  fixtureId:    number
  competition?: string
  participant1?: string
  participant2?: string
  startTime?:   number
}

/**
 * Goals for one side.
 *
 * TRAP: TxLINE omits the `Goals` key entirely for a team that did not score —
 * a clean sheet arrives as `{YellowCards: 4, Corners: 4}` with no Goals at all.
 * Reading that as "unknown" rather than zero made every 1-0 resolve with no
 * winner, which is a large fraction of soccer matches. Presence of the `Total`
 * object is what tells us the score is known; an absent Goals key inside it
 * means zero.
 */
const goalsOf = (side?: TxScoreSide): number | null =>
  side?.Total ? (side.Total.Goals ?? 0) : null

/**
 * Builds a resolution from a TxLINE `/scores/snapshot` array.
 *
 * ─── TWO TRAPS, BOTH CAPABLE OF MIS-SETTLING A MARKET ───────────────────────
 *
 * 1. THE ARRAY IS NOT A LOG. `/scores/snapshot` returns the latest event *per
 *    action type*, so array order is meaningless — observed Seq order in one
 *    response was 1236, 1259, 1261, 3, 10, 1235. Taking the last element, or
 *    the last element with a score, gives an arbitrary mid-match state. Always
 *    select by highest Seq.
 *
 * 2. SCORES ARE REVOCABLE. In Spain v Argentina (fixture 18257739) a `goal`
 *    event at Seq 1256 carried `Confirmed: false` and showed 2-0. A later
 *    `action_discarded` at Seq 1322 reverted it to 1-0, and `game_finalised`
 *    confirmed 1-0. VAR had disallowed the goal. Settling on the goal event
 *    would have paid out the wrong side.
 *
 * The safe rule, and the one implemented here: settle only on `game_finalised`
 * (or a documented terminal status), and never on an unconfirmed action.
 */
export function fromTxLine(
  sport: string,
  events: TxScoreEvent[],
  ref: SoccerFixtureRef
): Resolution {
  const observedAt = new Date().toISOString()
  const name = ref.participant1 && ref.participant2
    ? `${ref.participant1} v ${ref.participant2}`
    : `Fixture ${ref.fixtureId}`

  const base = {
    event_id:  String(ref.fixtureId),
    sport,
    name,
    season:    String(new Date(ref.startTime ?? Date.now()).getUTCFullYear()),
    round:     null,
    scheduled_at: ref.startTime ? new Date(ref.startTime).toISOString() : null,
    source:        'txline' as ProviderId,
    authoritative: true,
    observed_at:   observedAt,
  }

  if (!events.length) {
    return {
      ...base, status: 'scheduled', competitors: [], winner_id: null, winner: null,
      official: false, void_reason: null, finalized_at: null,
      notes: ['No score events published for this fixture yet.'],
    }
  }

  const bySeq     = [...events].sort((a, b) => b.Seq - a.Seq)
  const latest    = bySeq[0]
  const finalised = bySeq.find(e => e.Action === 'game_finalised' || e.StatusId === SOCCER_FINALISED)
  const terminal  = bySeq.find(e => e.StatusId != null && SOCCER_TERMINAL.has(e.StatusId))
  const voided    = bySeq.find(e => e.StatusId != null && e.StatusId in SOCCER_VOID)

  // Settlement reads from the finalised event; failing that, a documented
  // terminal status. Anything else is in-flight and must not be settled.
  const settleOn  = finalised ?? terminal
  const scoreFrom = settleOn?.Score
    ? settleOn
    : bySeq.find(e => e.Score)   // highest Seq carrying a score

  const p1 = goalsOf(scoreFrom?.Score?.Participant1)
  const p2 = goalsOf(scoreFrom?.Score?.Participant2)

  const notes: string[] = []
  if (finalised && finalised.StatusId === SOCCER_FINALISED) {
    notes.push('Settled on the game_finalised marker (StatusId 100), which is undocumented but present on every observed completed fixture.')
  }
  const unconfirmed = bySeq.filter(e => e.Confirmed === false && e.Score).length
  if (unconfirmed) {
    notes.push(`${unconfirmed} unconfirmed scoring event(s) were ignored — unconfirmed goals can be revoked by VAR.`)
  }

  const competitors: Competitor[] = [
    {
      competitor_id: String(ref.participant1 ?? latest.Participant1Id ?? 'p1'),
      name:          ref.participant1 ?? String(latest.Participant1Id ?? 'Participant 1'),
      team_id:       latest.Participant1Id != null ? String(latest.Participant1Id) : null,
      team:          ref.participant1 ?? null,
      position:      p1 != null && p2 != null ? (p1 > p2 ? 1 : p1 === p2 ? 1 : 2) : null,
      position_text: p1 != null && p2 != null ? (p1 > p2 ? 'W' : p1 === p2 ? 'D' : 'L') : '',
      status:        latest.StatusId != null ? SOCCER_STATUS[latest.StatusId] ?? String(latest.StatusId) : '',
      finished:      Boolean(settleOn),
      started:       (latest.StatusId ?? 1) !== 1,
      laps:          null,
      grid:          latest.Participant1IsHome ? 1 : 2,
      points:        p1,
    },
    {
      competitor_id: String(ref.participant2 ?? latest.Participant2Id ?? 'p2'),
      name:          ref.participant2 ?? String(latest.Participant2Id ?? 'Participant 2'),
      team_id:       latest.Participant2Id != null ? String(latest.Participant2Id) : null,
      team:          ref.participant2 ?? null,
      position:      p1 != null && p2 != null ? (p2 > p1 ? 1 : p1 === p2 ? 1 : 2) : null,
      position_text: p1 != null && p2 != null ? (p2 > p1 ? 'W' : p1 === p2 ? 'D' : 'L') : '',
      status:        latest.StatusId != null ? SOCCER_STATUS[latest.StatusId] ?? String(latest.StatusId) : '',
      finished:      Boolean(settleOn),
      started:       (latest.StatusId ?? 1) !== 1,
      laps:          null,
      grid:          latest.Participant1IsHome ? 2 : 1,
      points:        p2,
    },
  ]

  if (voided && !settleOn) {
    return {
      ...base, status: 'void', competitors, winner_id: null, winner: null,
      official: true, void_reason: SOCCER_VOID[voided.StatusId!],
      finalized_at: voided.Ts ? new Date(voided.Ts).toISOString() : observedAt,
      notes: [...notes, `Fixture ${SOCCER_STATUS[voided.StatusId!]} — no result.`],
    }
  }

  // A draw has no winner. Reporting one side as the winner because it sorted
  // first is precisely the kind of quiet error that settles a market wrongly.
  const isDraw  = p1 != null && p2 != null && p1 === p2
  const winner  = isDraw ? null : competitors.find(c => c.position === 1) ?? null

  const status: ResolutionStatus = settleOn
    ? 'official'
    : (latest.StatusId ?? 1) === 1 ? 'scheduled' : 'live'

  return {
    ...base,
    status,
    competitors,
    winner_id:   winner?.competitor_id ?? null,
    winner:      winner?.name ?? null,
    official:    Boolean(settleOn),
    void_reason: null,
    finalized_at: settleOn?.Ts ? new Date(settleOn.Ts).toISOString() : null,
    settled_seq: settleOn?.Seq,
    notes: isDraw && settleOn ? [...notes, 'Draw — no winner.'] : notes,
  }
}

/** Event registry from a TxLINE `/fixtures/snapshot` array. */
interface TxFixture {
  FixtureId: number; StartTime: number; Competition: string
  Participant1: string; Participant2: string; CompetitionId: number
}

export function eventsFromTxLine(sport: string, payload: unknown): EventRef[] {
  const list = Array.isArray(payload) ? payload as TxFixture[] : []
  return list.map(f => ({
    event_id:     String(f.FixtureId),
    sport,
    name:         `${f.Participant1} v ${f.Participant2}`,
    season:       String(new Date(f.StartTime).getUTCFullYear()),
    round:        f.Competition ?? null,
    scheduled_at: f.StartTime ? new Date(f.StartTime).toISOString() : null,
    source:       'txline' as ProviderId,
  }))
}

// ─── OpenDota (Dota 2) ───────────────────────────────────────────────────────
//
// Dota 2's outcome is a single boolean: `radiant_win`. That makes the mapping
// trivial and the FINALITY rule the only part worth thinking about.
//
// ─── Why a completed match is not immediately official ───────────────────────
// A match can surface in /proMatches before replay parsing completes, results can
// be re-parsed, and rare technical remakes exist. An oracle that labels a result
// final and then changes it is worse than one that is slow. So a resolved match
// is held at `provisional` until it has stood unchanged for a confirmation
// window, and only then reports official.
//
// This is an ageing rule over a single authoritative source, which is weaker than
// two independent sources agreeing. It is stated in `notes` on every provisional
// response rather than hidden behind the flag, so a conservative caller can apply
// a longer window of its own. No open second source for Dota 2 exists to
// corroborate against — see providers/liquipedia.ts for why.
//
// It costs nothing: the raw document is cached either way, so re-reading it after
// the window is a cache hit, and /resolve promotes to the 30-day TTL once official.

const DOTA_CONFIRMATION_WINDOW_MS = 6 * 60 * 60 * 1000

/** The projected shape from providers/opendota.ts — one form for all 3 endpoints. */
export interface DotaMatch {
  match_id:      string | null
  radiant_win?:  boolean
  radiant_score: number | null
  dire_score:    number | null
  start_time:    number | null
  duration:      number | null
  league_id:     string | null
  league_name:   string | null
  radiant_name:  string | null
  dire_name:     string | null
  series_id?:    string | null
  series_type?:  number | null
  in_progress?:  boolean
}

/** OpenDota's series_type. 0 is a standalone match, not a series. */
const SERIES_LABEL: Record<number, string> = { 1: 'best-of-3', 2: 'best-of-5' }

function dotaSide(
  id:       'radiant' | 'dire',
  name:     string | null,
  score:    number | null,
  resolved: boolean,
  won:      boolean,
  started:  boolean
): Competitor {
  return {
    competitor_id: id,
    name:          name ?? (id === 'radiant' ? 'Radiant' : 'Dire'),
    // Dota teams are the competitors; there is no separate parent org concept
    // in the match feed, so team mirrors name rather than inventing an id.
    team_id:       null,
    team:          name ?? null,

    position:      resolved ? (won ? 1 : 2) : null,
    position_text: resolved ? (won ? 'W' : 'L') : '',
    status:        resolved ? (won ? 'Won' : 'Lost') : started ? 'In progress' : 'Scheduled',

    finished:      resolved,
    started,

    laps:          null,
    grid:          null,
    // Kill score. NOT a series scoreline — see the series note below.
    points:        score,
  }
}

export function fromOpenDota(sport: string, m: DotaMatch | null): Resolution | null {
  if (!m || !m.match_id) return null

  const observedAt = new Date().toISOString()

  // typeof, never truthiness: `false` is a valid, meaningful outcome (dire won)
  // and `undefined` means unresolved. Conflating them settles every in-progress
  // match in dire's favour.
  const resolved = typeof m.radiant_win === 'boolean'
  const startMs  = m.start_time != null ? m.start_time * 1000 : null
  const endedMs  = startMs != null && m.duration != null ? startMs + m.duration * 1000 : null
  const started  = startMs != null && startMs <= Date.now()

  // Held provisional until the window elapses. A resolved match with no usable
  // end time cannot be aged, so it stays provisional rather than being promoted
  // on an assumption.
  const confirmed = resolved
    && endedMs != null
    && Date.now() - endedMs >= DOTA_CONFIRMATION_WINDOW_MS

  const status: ResolutionStatus = resolved
    ? (confirmed ? 'official' : 'provisional')
    : (m.in_progress || started) ? 'live' : 'scheduled'

  const radiantWon = m.radiant_win === true
  const competitors: Competitor[] = [
    dotaSide('radiant', m.radiant_name, m.radiant_score, resolved,  radiantWon, started),
    dotaSide('dire',    m.dire_name,    m.dire_score,    resolved, !radiantWon, started),
  ]

  const winner = resolved
    ? competitors.find(c => c.position === 1) ?? null
    : null

  const notes: string[] = []

  if (resolved && !confirmed) {
    const readyAt = endedMs != null
      ? new Date(endedMs + DOTA_CONFIRMATION_WINDOW_MS).toISOString()
      : null
    notes.push(
      `Winner reported but inside the ${DOTA_CONFIRMATION_WINDOW_MS / 3600000}h confirmation `
      + `window — OpenDota can re-parse a replay and technical remakes exist. NOT settleable`
      + (readyAt ? ` until ${readyAt}.` : ' until the match end time is known.')
    )
  }

  if (confirmed) {
    notes.push(
      `Official via the ${DOTA_CONFIRMATION_WINDOW_MS / 3600000}h ageing rule over a single `
      + `authoritative source (Valve WebAPI via OpenDota). This is weaker than two independent `
      + `sources agreeing; no open second source exists for Dota 2.`
    )
  }

  // A market on a Bo3/Bo5 must NOT settle on one game id. OpenDota match ids are
  // per-game; the games of a series share a series_id. Settling a series market
  // on the first game that resolves would pay out on a single map.
  const seriesLabel = m.series_type != null ? SERIES_LABEL[m.series_type] : undefined
  if (seriesLabel && m.series_id) {
    notes.push(
      `This is ONE GAME of a ${seriesLabel} series (series_id ${m.series_id}). `
      + `A series market must aggregate every match sharing that series_id — this `
      + `resolution settles the single game only.`
    )
  }

  return {
    event_id:     m.match_id,
    sport,
    name:         `${m.radiant_name ?? 'Radiant'} vs ${m.dire_name ?? 'Dire'}`,
    season:       String(new Date(startMs ?? Date.now()).getUTCFullYear()),
    round:        m.league_name ?? m.league_id ?? null,

    status,
    scheduled_at: startMs != null ? new Date(startMs).toISOString() : null,

    competitors,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,

    official:     status === 'official',
    // Dota 2 has no void concept in this feed — an abandoned match simply never
    // resolves. Inventing a void from absence would settle markets that should
    // stand, the same trap documented for Jolpica above.
    void_reason:  null,

    source:        'opendota',
    authoritative: true,
    observed_at:   observedAt,
    finalized_at:  confirmed && endedMs != null ? new Date(endedMs).toISOString() : null,
    notes,
  }
}

/** Event registry from a /proMatches or /live array. */
export function eventsFromOpenDota(sport: string, payload: unknown): EventRef[] {
  const rows = Array.isArray(payload) ? payload as DotaMatch[] : []
  return rows
    .filter(m => m.match_id)
    .map(m => ({
      event_id:     m.match_id!,
      sport,
      name:         `${m.radiant_name ?? 'Radiant'} vs ${m.dire_name ?? 'Dire'}`,
      season:       String(new Date(m.start_time != null ? m.start_time * 1000 : Date.now()).getUTCFullYear()),
      round:        m.league_name ?? m.league_id ?? null,
      scheduled_at: m.start_time != null ? new Date(m.start_time * 1000).toISOString() : null,
      source:       'opendota' as ProviderId,
    }))
}

/** Finds one match in a cached /proMatches array. */
export function findDotaMatch(payload: unknown, matchId: string): DotaMatch | null {
  const rows = Array.isArray(payload) ? payload as DotaMatch[] : []
  return rows.find(m => m.match_id === matchId) ?? null
}

// ─── Agent Fighter ───────────────────────────────────────────────────────────
//
// The cleanest source in this file to map, because it was built for settlement
// rather than adapted to it. `resolution.settlement` is an explicit three-state
// field and it is the ONLY thing that gates `official` here:
//
//   final       the result can never change      -> official
//   void        no contest, refund               -> void (settleable as void)
//   provisional not yet re-simulated             -> provisional, NEVER settle
//
// No ageing rule, unlike Dota 2. The six-hour window there exists because
// OpenDota's payload cannot distinguish a first parse from a settled one, so we
// infer confidence from elapsed time. Agent Fighter tells us directly, so
// inferring it again would only add latency. See providers/agentfighter.ts.
//
// ─── Where this layer stops: forfeits ────────────────────────────────────────
// The upstream is explicit that a forfeit is reported as `outcome: decided`,
// `method: forfeit`, `settlement: final` — in Agent Fighter, leaving a wager
// loses it by design. Its documentation says: "Many books void forfeits under
// their own rules. We state what happened; you choose what to pay."
//
// That is exactly the boundary declared at the top of this file. A forfeit
// therefore resolves as a DECIDED WIN with the method carried in `status` and a
// note naming it. Voiding it here would be this layer inventing a house rule and
// silently imposing it on every market built on the API.
//
// ─── Two ways a result can be true but unpriceable ───────────────────────────
// Both are surfaced in `notes` rather than in the flag, because both are facts
// about the match, not about whether the outcome is known:
//
//   verified: false     the winner was awarded because a side vanished, NOT by
//                       re-simulating the ledger. The result stands; the
//                       cryptographic guarantee does not apply to it.
//   rated: false        arcade / solo / friendly material. The platform runs far
//                       more practice than wagers, and a market priced on
//                       exhibition play is priced on noise.

/** One side of a match. Agent Fighter is 1v1, so there are exactly two. */
export interface AFPlayer {
  handle?:     string
  name?:       string
  character?:  string
  is_agent?:   boolean
  rounds_won?: number
  won?:        boolean
}

export interface AFResolutionBlock {
  outcome?:     string   // closed enum: decided | draw | no_contest
  method?:      string   // OPEN enum — never switch exhaustively on this
  settlement?:  string   // closed enum: final | void | provisional
  winner_side?: number | null
  verified?:    boolean
  desync_side?: number | null
}

/** The projected shape from providers/agentfighter.ts — one form for both endpoints. */
export interface AFMatch {
  id?:         string
  played_at?:  string
  season?:     number
  mode?:       string
  rated?:      boolean
  stakes?:     { entry_fee?: number; pot?: number; currency?: string }
  players?:    AFPlayer[]
  resolution?: AFResolutionBlock
  duration?:   { ticks?: number; seconds?: number }
  verification?: { engine?: string; state_hash?: string; verified?: boolean; desync_side?: number | null }
}

/** Reads the array out of the projected `{ matches: [...] }` envelope. */
export function agentFighterMatches(payload: unknown): AFMatch[] {
  const d = payload as { matches?: unknown }
  return Array.isArray(d?.matches) ? (d.matches as AFMatch[]) : []
}

export function findAgentFighterMatch(payload: unknown, matchId: string): AFMatch | null {
  return agentFighterMatches(payload).find(m => m.id === matchId) ?? null
}

const afLabel = (p: AFPlayer | undefined, idx: number): string =>
  p?.name ?? p?.handle ?? `Side ${idx}`

const afName = (m: AFMatch): string => {
  const p = m.players ?? []
  return `${afLabel(p[0], 0)} vs ${afLabel(p[1], 1)}`
}

/** Methods where the losing side did not play the match to a conclusion. */
const AF_FORFEIT = /forfeit/i

function afSide(
  p:   AFPlayer,
  idx: number,
  ctx: {
    resolved:   boolean
    draw:       boolean
    won:        boolean
    method:     string
    desyncSide: number | null
  }
): Competitor {
  const { resolved, draw, won, method, desyncSide } = ctx
  const convicted = desyncSide === idx
  const forfeited = AF_FORFEIT.test(method) && !won

  const status =
    !resolved  ? 'No contest'
    : convicted ? 'Desync conviction — reported state diverged from the server re-simulation'
    : draw      ? 'Draw'
    : won       ? `Won (${method})`
    :             `Lost (${method})`

  return {
    competitor_id: p.handle ?? String(idx),
    name:          afLabel(p, idx),

    // The selected fighter, carried in the team slot.
    //
    // A stretch on the word "team", so it is worth defending: the contract calls
    // this the "constructor / team / club" slot, i.e. what the competitor brought
    // rather than who they are. Character selection is exactly that, and it is a
    // first-class market dimension here — the upstream publishes per-character
    // win rates and pick rates precisely because it is modelled. Putting it here
    // lets /resolve answer "which fighter won" without a second call. There are
    // no team markets in a 1v1 game for this to be confused with.
    team_id:       p.character ?? null,
    team:          p.character ?? null,

    position:      !resolved ? null : draw ? 1 : won ? 1 : 2,
    position_text: !resolved ? ''   : draw ? 'D' : won ? 'W' : 'L',
    status,

    // "Played it to a conclusion." False for a walkout and for an anti-cheat
    // conviction — in both cases the result stands but the match did not finish
    // on its own terms, which is the distinction a book needs to apply its own
    // forfeit rule.
    finished:      resolved && !convicted && !forfeited,
    // Every row this API serves is a match that was played. There is no
    // scheduled or no-show state to represent.
    started:       true,

    laps:          null,
    // Side index, 1-based. The same use soccer makes of this field for
    // home/away — it is the only positional information a 1v1 match carries.
    grid:          idx + 1,
    // Rounds won. The scoreline, not a series score.
    points:        p.rounds_won ?? null,
  }
}

export function fromAgentFighter(sport: string, m: AFMatch | null): Resolution | null {
  if (!m || !m.id) return null

  const observedAt = new Date().toISOString()
  const r          = m.resolution ?? {}
  const players    = Array.isArray(m.players) ? m.players : []

  const settlement = r.settlement
  const outcome    = r.outcome
  const method     = r.method ?? 'unspecified'
  const desyncSide = typeof r.desync_side === 'number' ? r.desync_side : null

  // `final` and `void` are the only values that may produce a settleable
  // response. Anything else — `provisional`, or a value this build has never
  // seen — is withheld. A settlement enum that grows must never fail open.
  const isFinal = settlement === 'final'
  const voided  = settlement === 'void' || (isFinal && outcome === 'no_contest')
  const draw    = isFinal && outcome === 'draw'

  // Whether the match produced a placeable order. Reported even while
  // provisional — the positions are facts; `official` is what gates settlement.
  const resolved = !voided && (outcome === 'decided' || outcome === 'draw')

  const winnerSide = typeof r.winner_side === 'number' ? r.winner_side : null

  // Two independent statements of who won: `resolution.winner_side` and the
  // per-player `won` flag. They should never disagree. If they do, something
  // upstream is inconsistent and no market may settle on it — cheap to check,
  // and the failure it guards against is paying the wrong side.
  const flaggedWinner = players.findIndex(p => p.won === true)
  const conflicted =
    outcome === 'decided' &&
    winnerSide !== null &&
    flaggedWinner !== -1 &&
    flaggedWinner !== winnerSide

  const status: ResolutionStatus =
    conflicted ? 'provisional'
    : voided    ? 'void'
    : isFinal   ? 'official'
    :             'provisional'

  const official = !conflicted && (voided || isFinal)

  const competitors: Competitor[] = players.map((p, idx) =>
    afSide(p, idx, {
      resolved,
      draw,
      won: draw ? false : winnerSide !== null ? idx === winnerSide : p.won === true,
      method,
      desyncSide,
    })
  )

  // A draw has no winner, and neither does a void. Reporting one because a side
  // sorted first is the quiet error that settles a market wrongly.
  const winner = resolved && !draw && winnerSide !== null
    ? competitors[winnerSide] ?? null
    : null

  const notes: string[] = []

  if (conflicted) {
    notes.push(
      `CONFLICT: resolution.winner_side is ${winnerSide} but players[${flaggedWinner}].won is true. `
      + `The upstream disagrees with itself about who won, so this is held at provisional and is `
      + `NOT settleable regardless of resolution.settlement being "${settlement}".`
    )
  }

  if (!isFinal && settlement !== 'void') {
    notes.push(
      `resolution.settlement is "${settlement ?? 'absent'}", not "final" — the match has not been `
      + `re-simulated to a settled state. NOT settleable.`
    )
  }

  if (voided) {
    notes.push(`No contest (method ${method}) — nothing was decided. Refund rather than pay out.`)
  }

  if (draw) notes.push('Draw — no winner.')

  // The single most important caveat this source carries. `verified: false`
  // means the win was awarded because a side vanished, not because the ledger
  // was replayed — the determinism guarantee does not cover this row.
  if (r.verified === false) {
    notes.push(
      'NOT VERIFIED: this result was awarded without re-simulating the input ledger — a side '
      + 'vanished and the win was granted by default. The outcome stands, but the deterministic '
      + 'guarantee that makes this source authoritative does not apply to it.'
    )
  }

  if (desyncSide !== null) {
    notes.push(
      `Anti-cheat conviction: side ${desyncSide} (${afLabel(players[desyncSide], desyncSide)}) had `
      + `reported state hashes diverge from the server re-simulation. This is the anti-cheat firing, `
      + `not a normal loss.`
    )
  }

  if (AF_FORFEIT.test(method)) {
    notes.push(
      `Decided by ${method}. Agent Fighter treats leaving a wager as losing it, so this is reported `
      + `as a decided win, not a void. Many books void forfeits under their own rules — that is a `
      + `market-layer decision and this API deliberately does not make it for you.`
    )
  }

  // The platform runs far more practice than wagers. A market priced on arcade
  // material is priced on noise, and the mode is not otherwise visible in the
  // normalised shape.
  if (m.rated === false || (m.mode && m.mode !== 'wager')) {
    notes.push(
      `Not a rated wager (mode "${m.mode ?? 'unknown'}", rated ${m.rated ?? 'unknown'}). `
      + `Exhibition or practice material — confirm this is a population you intend to price before `
      + `building a market on it.`
    )
  }

  if (players.some(p => p.is_agent)) {
    const who = players
      .map((p, i) => (p.is_agent ? `side ${i} (${afLabel(p, i)})` : null))
      .filter(Boolean)
      .join(', ')
    notes.push(`AI agent participant — ${who}. Humans and agents share one arena here.`)
  }

  // Provenance for a settlement dispute. The state hash is reproducible: replay
  // the same inputs on the same engine build and it must match. This is what
  // `settled_seq` is for TxLINE — a handle to check the result against, not a
  // claim to be trusted.
  if (official && m.verification?.state_hash) {
    notes.push(
      `Verifiable: engine ${m.verification.engine ?? 'unknown'}, state_hash `
      + `${m.verification.state_hash}. Results are only comparable within one engine build.`
    )
  }

  return {
    event_id:     m.id,
    sport,
    name:         afName(m),
    season:       m.season != null ? String(m.season) : '',
    // Mode is the competition class here (wager / arcade / solo / friendly),
    // which is the closest analogue to the competition name soccer puts in this
    // field. It is also what tells a consumer whether the match was for stakes.
    round:        m.mode ?? null,

    status,
    // The only timestamp the feed carries. Every row is already played, so this
    // is both the start time and the time of record.
    scheduled_at: m.played_at ?? null,

    competitors,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,

    official,
    void_reason:  voided ? 'no_contest' : null,

    source:        'agentfighter',
    authoritative: true,
    observed_at:   observedAt,
    // Documented as immutable once written, so the moment of record is the
    // moment it was played.
    finalized_at:  official ? m.played_at ?? observedAt : null,
    notes,
  }
}

/** Event registry from a projected `/matches` page. */
export function eventsFromAgentFighter(sport: string, payload: unknown): EventRef[] {
  return agentFighterMatches(payload)
    .filter(m => m.id)
    .map(m => ({
      event_id:     m.id!,
      sport,
      name:         afName(m),
      season:       m.season != null ? String(m.season) : '',
      round:        m.mode ?? null,
      scheduled_at: m.played_at ?? null,
      source:       'agentfighter' as ProviderId,
    }))
}

// ─── OpenF1 (provisional) ────────────────────────────────────────────────────

interface OpenF1SessionResult {
  position:        number | null
  driver_number:   number
  number_of_laps?: number | null
  points?:         number | null
  dnf?:            boolean
  dns?:            boolean
  dsq?:            boolean
}
interface OpenF1Driver   { driver_number: number; full_name?: string; broadcast_name?: string; team_name?: string }
interface OpenF1RaceControl { category?: string; message?: string; date?: string }

/**
 * Builds a PROVISIONAL resolution from OpenF1's session_result.
 *
 * `official` is hardcoded false and `status` can never exceed 'provisional',
 * regardless of how complete the data looks. OpenF1 is not the governing body
 * and does not see post-race penalties — that cap is the entire reason both
 * providers exist rather than one.
 *
 * session_result carries dnf/dns/dsq as explicit booleans, so unlike the raw
 * position stream it can distinguish a retirement from a driver who simply
 * stopped receiving updates.
 *
 * Note a retiree here has position = null: OpenF1 reports who stopped, but does
 * not produce a classification order for them. Jolpica does (a driver who retired
 * on lap 5 is still classified P19). That gap alone makes OpenF1 unusable for
 * head-to-head settlement, independent of the penalty problem.
 */
export function fromOpenF1(
  sport: string,
  sessionKey: string,
  results: OpenF1SessionResult[],
  drivers: OpenF1Driver[],
  raceControl: OpenF1RaceControl[] = []
): Resolution {
  const driverByNumber = new Map(drivers.map(d => [d.driver_number, d]))

  const competitors: Competitor[] = [...results]
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    .map(r => {
      const d       = driverByNumber.get(r.driver_number)
      const retired = Boolean(r.dnf || r.dns || r.dsq)

      return {
        competitor_id: String(r.driver_number),
        name:          d?.full_name ?? d?.broadcast_name ?? String(r.driver_number),
        team_id:       null,
        team:          d?.team_name ?? null,
        position:      r.position ?? null,
        position_text: r.dsq ? 'D' : r.dns ? 'W' : r.dnf ? 'R' : String(r.position ?? ''),
        status:        r.dsq ? 'Disqualified' : r.dns ? 'Did not start'
                     : r.dnf ? 'Retired'      : 'Classified',
        finished:      !retired,
        started:       !r.dns,
        laps:          r.number_of_laps ?? null,
        grid:          null,
        points:        r.points ?? null,
      }
    })

  // Anything the stewards are looking at is a reason to withhold settlement.
  const investigations = raceControl
    .filter(m => /investigat|penalt|under review|disqualif/i.test(m.message ?? ''))
    .map(m => m.message!)

  const winner = competitors[0] ?? null

  return {
    event_id:     sessionKey,
    sport,
    name:         `Session ${sessionKey}`,
    season:       String(new Date().getUTCFullYear()),
    round:        null,

    status:       'provisional',
    scheduled_at: null,

    competitors,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,

    official:     false,
    void_reason:  null,

    source:        'openf1',
    authoritative: false,
    observed_at:   new Date().toISOString(),
    finalized_at:  null,
    notes: [
      'Provisional live timing. Not a settlement source — awaiting official classification.',
      ...investigations,
    ],
  }
}

// ─── Sportradar ──────────────────────────────────────────────────────────────
//
// Sportradar covers seven of our nine serving sports and is the licensed,
// authoritative distributor for all of them, yet it had no settlement mapper at
// all: RESOLVERS held only f1, soccer, dota2 and agentfighter. That was an
// accident of build order rather than a decision. The resolution layer arrived
// with the multivertical expansion, the Sportradar sports predate it, and nobody
// went back. Nothing in this file, the provider registry or the build plans ever
// argued Sportradar should be excluded, and providers/sportradar.ts has carried
// `authoritative: true` throughout.
//
// The practical effect was that a prediction market could price NBA, NFL, NHL,
// MLB, WNBA, tennis and MMA off our data but could not settle any of them.
//
// ─── Finality: `closed` settles, `complete` does not ─────────────────────────
// Sportradar publishes two distinct end states, and the difference is exactly
// the provisional/official boundary this contract needs:
//
//   complete  play has finished, statistics are not yet reviewed
//   closed    statistics reviewed and final
//
// So `closed` maps to official and `complete` maps to provisional. That is a
// real upstream signal rather than an ageing heuristic like the Dota 2 window,
// which makes these the strongest settlement sources here after Agent Fighter.
//
// ─── Two payload families ────────────────────────────────────────────────────
// Every shape below was verified against payloads observed in our own cache on
// 2026-09-02, not taken from documentation:
//
//   games      NBA, NHL, WNBA, NFL, MLB. A game object with home/away team
//              objects. Points live in THREE different places depending on the
//              sport, which is the reason pointsOf() exists.
//   summaries  tennis, MMA. The unified v2/v3 sport_event + sport_event_status
//              envelope, carrying an explicit winner_id.

/** Sportradar statuses meaning no result will be produced. */
const SR_VOID: Record<string, VoidReason> = {
  cancelled:   'cancelled',
  postponed:   'postponed',
  abandoned:   'abandoned',
  unnecessary: 'cancelled',
}

/**
 * Statuses where play has finished.
 *
 * Both are terminal for knowing who won, but only `closed` is settleable, so the
 * two must stay distinguishable rather than collapsing into one "finished".
 */
const SR_FINISHED = new Set(['closed', 'complete'])
const SR_LIVE     = new Set(['inprogress', 'halftime', 'delayed', 'suspended'])

interface SrTeam {
  id?:     string
  name?:   string
  market?: string
  alias?:  string
  abbr?:   string
  points?: number
  runs?:   number
}

interface SrGame {
  id?:          string
  status?:      string
  scheduled?:   string
  home?:        SrTeam
  away?:        SrTeam
  home_points?: number
  away_points?: number
  scoring?:     { home_points?: number; away_points?: number }
  season?:      { year?: number | string; type?: string }
}

/**
 * A team's score, wherever this sport happens to keep it.
 *
 * Verified placements, all three live in our cache today:
 *   NBA / NHL / WNBA   game.home_points          top level, beside the teams
 *   NFL                game.scoring.home_points  nested under scoring
 *   MLB                game.home.runs            on the team object; the MLB
 *                                                schedule document carries no
 *                                                top-level points at all
 *
 * Returning null rather than 0 for absent matters: 0 is a legitimate score in
 * every one of these sports, and conflating the two would settle a scoreless
 * game as a draw against a team that simply has no reported score yet.
 */
function pointsOf(game: SrGame, side: 'home' | 'away'): number | null {
  const key  = side === 'home' ? 'home_points' : 'away_points'
  const team = game[side]
  const candidates = [game[key], game.scoring?.[key], team?.points, team?.runs]
  const found = candidates.find(v => typeof v === 'number')
  return typeof found === 'number' ? found : null
}

/** Display name. MLB splits the club across market and name: "San Diego" + "Padres". */
function teamName(t: SrTeam | undefined, fallback: string): string {
  if (!t) return fallback
  const full = [t.market, t.name].filter(Boolean).join(' ').trim()
  return full || t.alias || t.abbr || fallback
}

function srCompetitor(
  game:     SrGame,
  side:     'home' | 'away',
  opponent: 'home' | 'away',
  finished: boolean,
  started:  boolean
): Competitor {
  const team   = game[side]
  const mine   = pointsOf(game, side)
  const theirs = pointsOf(game, opponent)
  const known  = finished && mine !== null && theirs !== null

  const won  = known && mine! > theirs!
  const drew = known && mine! === theirs!
  const label = teamName(team, side === 'home' ? 'Home' : 'Away')

  return {
    competitor_id: team?.id ?? side,
    name:          label,
    // In a league fixture the competitor IS the team, so team mirrors the
    // identity rather than inventing a parent org. Same choice as the Dota 2 mapper.
    team_id:       team?.id ?? null,
    team:          label,

    // A draw leaves both sides on position 1. There is no second place in a tie,
    // and ranking one below the other would silently invent a winner.
    position:      known ? (drew || won ? 1 : 2) : null,
    position_text: known ? (drew ? 'D' : won ? 'W' : 'L') : '',
    status:        known ? (drew ? 'Draw' : won ? 'Won' : 'Lost')
                         : started ? 'In progress' : 'Scheduled',

    finished,
    started,

    laps:   null,
    // Home advantage is a real pricing input, and grid is the only free numeric
    // slot in the contract that can carry it. 1 = home, 2 = away, matching soccer.
    grid:   side === 'home' ? 1 : 2,
    points: mine,
  }
}

/** Normalises one Sportradar game object: NBA, NHL, WNBA, NFL, MLB. */
export function fromSportradarGame(sport: string, game: SrGame | null): Resolution | null {
  if (!game?.id) return null

  const observedAt = new Date().toISOString()
  const rawStatus  = (game.status ?? '').toLowerCase()

  const finished = SR_FINISHED.has(rawStatus)
  const started  = finished || SR_LIVE.has(rawStatus)
  const voidedAs = SR_VOID[rawStatus]

  const home = srCompetitor(game, 'home', 'away', finished, started)
  const away = srCompetitor(game, 'away', 'home', finished, started)

  const base = {
    event_id:     game.id,
    sport,
    name:         `${away.name} at ${home.name}`,
    season:       String(game.season?.year ?? new Date(game.scheduled ?? Date.now()).getUTCFullYear()),
    round:        game.season?.type ?? null,
    scheduled_at: game.scheduled ? new Date(game.scheduled).toISOString() : null,
    competitors:  [home, away],
    source:        'sportradar' as ProviderId,
    authoritative: true,
    observed_at:   observedAt,
  }

  if (voidedAs) {
    return {
      ...base,
      status: 'void', winner_id: null, winner: null,
      official: true, void_reason: voidedAs,
      finalized_at: observedAt,
      notes: [`Game ${rawStatus} — no result.`],
    }
  }

  // Only `closed` settles. See the finality note above.
  const official = rawStatus === 'closed' && home.points !== null && away.points !== null
  const status: ResolutionStatus = official ? 'official'
    : finished ? 'provisional'
    : started  ? 'live'
    :            'scheduled'

  const drew   = home.points !== null && away.points !== null && home.points === away.points
  const winner = official && !drew ? (home.points! > away.points! ? home : away) : null

  const notes: string[] = []
  if (rawStatus === 'complete') {
    notes.push(
      'Sportradar reports this game as `complete`: play has finished but the statistics '
      + 'are not yet reviewed. Held at provisional until the status becomes `closed`, '
      + 'which is the settleable state.'
    )
  }
  if (finished && (home.points === null || away.points === null)) {
    notes.push('Game is finished but a score is missing from the upstream document — not settleable.')
  }
  if (drew && official) notes.push('Draw — no winner.')

  return {
    ...base,
    status,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,
    official,
    void_reason:  null,
    finalized_at: official ? observedAt : null,
    notes,
  }
}

/**
 * Walks a Sportradar schedule document to its games.
 *
 * NBA, NHL, WNBA and MLB expose a flat `games` array. NFL nests them a level
 * deeper under `weeks[].games[]`, which is why this is a function rather than a
 * property read: resolving an NFL game against `payload.games` finds nothing and
 * reports every NFL market as unknown.
 */
function srGames(payload: unknown): SrGame[] {
  const doc = payload as {
    games?:  unknown[]
    weeks?:  { games?: unknown[] }[]
    league?: { games?: unknown[] }
  } | null

  // Three roots, all observed live on 2026-09-02:
  //   games          NBA / NHL / WNBA / MLB season schedule, NBA / NHL / WNBA daily
  //   weeks[].games  NFL season schedule
  //   league.games   MLB daily boxscore, the only document that carries MLB runs
  const rows: unknown[] =
      Array.isArray(doc?.games)         ? doc.games
    : Array.isArray(doc?.weeks)         ? doc.weeks.flatMap(w => w.games ?? [])
    : Array.isArray(doc?.league?.games) ? doc.league.games
    : []

  // MLB's daily document is a boxscore feed, which wraps each entry as
  // `{ game: {...} }` rather than putting the game at the top of the row. Every
  // other sport's daily and season documents are unwrapped. Normalising here
  // rather than in each caller keeps the two shapes from leaking outwards, and
  // an unwrapped row is passed through untouched, so this is a no-op everywhere
  // else.
  return rows.map(r => {
    const row = r as { game?: SrGame }
    return (row?.game ?? row) as SrGame
  })
}

export function eventsFromSportradarGames(sport: string, payload: unknown): EventRef[] {
  return srGames(payload)
    .filter(g => g.id)
    .map(g => ({
      event_id:     g.id!,
      sport,
      name:         `${teamName(g.away, 'Away')} at ${teamName(g.home, 'Home')}`,
      season:       String(g.season?.year ?? new Date(g.scheduled ?? Date.now()).getUTCFullYear()),
      round:        g.season?.type ?? null,
      scheduled_at: g.scheduled ? new Date(g.scheduled).toISOString() : null,
      source:       'sportradar' as ProviderId,
    }))
}

/** Finds one game in a cached schedule document, flat or week-nested. */
export function findSportradarGame(payload: unknown, gameId: string): SrGame | null {
  return srGames(payload).find(g => g.id === gameId) ?? null
}

// ─── Sportradar unified feed: tennis and MMA ─────────────────────────────────

interface SrEventCompetitor {
  id?:           string
  name?:         string
  qualifier?:    string
  abbreviation?: string
  seed?:         number
}

interface SrSummary {
  sport_event?: {
    id?:          string
    start_time?:  string
    competitors?: SrEventCompetitor[]
    sport_event_context?: {
      season?:      { name?: string; year?: string }
      round?:       { name?: string }
      competition?: { name?: string }
    }
  }
  sport_event_status?: {
    status?:       string
    match_status?: string
    winner_id?:    string
    home_score?:   number
    away_score?:   number
    /** MMA only: the finish method, e.g. ko_tko, submission, decision. */
    method?:       string
    final_round?:  number
    title_fight?:  boolean
  }
}

/**
 * Normalises one tennis or MMA summary.
 *
 * Structurally simpler than the game mapper because the upstream states the
 * outcome directly: sport_event_status.winner_id names the winner, so there is
 * no score comparison to get wrong. Scores are still carried as `points` (sets
 * won, in tennis) because they are a legitimate input for handicap and total
 * markets.
 *
 * MMA's `method` is surfaced in notes rather than mapped into the contract.
 * Method-of-victory is a market type, and per this file's opening boundary the
 * data layer reports facts while the market layer decides what they pay. A
 * `method` field here would be the first step towards encoding market rules in
 * the data layer.
 */
export function fromSportradarSummary(sport: string, s: SrSummary | null): Resolution | null {
  const event = s?.sport_event
  const state = s?.sport_event_status
  if (!event?.id) return null

  const observedAt = new Date().toISOString()
  const rawStatus  = (state?.status ?? '').toLowerCase()

  const finished = SR_FINISHED.has(rawStatus)
  const started  = finished || SR_LIVE.has(rawStatus)
  const voidedAs = SR_VOID[rawStatus]

  const ctx      = event.sport_event_context
  const hasWinner = Boolean(state?.winner_id)

  const competitors: Competitor[] = (event.competitors ?? []).map(c => {
    const won   = finished && hasWinner && c.id === state!.winner_id
    const score = c.qualifier === 'home' ? state?.home_score : state?.away_score
    return {
      competitor_id: c.id ?? '',
      name:          c.name ?? c.abbreviation ?? '',
      // Tennis singles and MMA are individual sports; there is no club.
      team_id:       null,
      team:          null,

      position:      finished && hasWinner ? (won ? 1 : 2) : null,
      position_text: finished && hasWinner ? (won ? 'W' : 'L') : '',
      status:        finished && hasWinner ? (won ? 'Won' : 'Lost')
                     : started ? 'In progress' : 'Scheduled',

      finished,
      // A walkover or retirement still carries a winner_id, so the presence of an
      // outcome must never be read as proof that both competitors started.
      started,

      laps:   null,
      // Seeding is a genuine pricing input and grid is the only free numeric slot
      // here. Null for MMA, which publishes no seed.
      grid:   typeof c.seed === 'number' ? c.seed : null,
      points: typeof score === 'number' ? score : null,
    }
  })

  const base = {
    event_id:     event.id,
    sport,
    name:         competitors.length === 2
      ? `${competitors[0].name} vs ${competitors[1].name}`
      : ctx?.competition?.name ?? event.id,
    season:       ctx?.season?.year ?? String(new Date(event.start_time ?? Date.now()).getUTCFullYear()),
    round:        ctx?.round?.name ?? null,
    scheduled_at: event.start_time ? new Date(event.start_time).toISOString() : null,
    competitors,
    source:        'sportradar' as ProviderId,
    authoritative: true,
    observed_at:   observedAt,
  }

  if (voidedAs) {
    return {
      ...base,
      status: 'void', winner_id: null, winner: null,
      official: true, void_reason: voidedAs,
      finalized_at: observedAt,
      notes: [`Event ${rawStatus} — no result.`],
    }
  }

  // Same rule as the game mapper: `closed` settles, `complete` does not. A
  // winner_id must also be present; a finished event with no stated winner is not
  // something to guess at.
  const official = rawStatus === 'closed' && hasWinner
  const status: ResolutionStatus = official ? 'official'
    : finished ? 'provisional'
    : started  ? 'live'
    :            'scheduled'

  const winner = official
    ? competitors.find(c => c.competitor_id === state!.winner_id) ?? null
    : null

  const notes: string[] = []
  if (rawStatus === 'complete') {
    notes.push(
      'Sportradar reports this event as `complete`: the result is known but the '
      + 'statistics are not yet reviewed. Held at provisional until `closed`.'
    )
  }
  if (finished && !hasWinner) {
    notes.push('Event is finished but the upstream states no winner_id — not settleable.')
  }
  if (state?.method) {
    notes.push(
      `Method of victory: ${state.method}`
      + (state.final_round ? ` in round ${state.final_round}` : '')
      + '. Reported as a fact — method and round markets are settled by the market layer, not here.'
    )
  }
  if (state?.match_status && state.match_status !== 'ended') {
    notes.push(`Upstream match_status is "${state.match_status}".`)
  }

  return {
    ...base,
    status,
    winner_id:    winner?.competitor_id ?? null,
    winner:       winner?.name ?? null,
    official,
    void_reason:  null,
    finalized_at: official ? observedAt : null,
    notes,
  }
}

function srSummaries(payload: unknown): SrSummary[] {
  const doc = payload as { summaries?: SrSummary[] } | null
  return Array.isArray(doc?.summaries) ? doc.summaries : []
}

export function eventsFromSportradarSummaries(sport: string, payload: unknown): EventRef[] {
  return srSummaries(payload)
    .filter(s => s.sport_event?.id)
    .map(s => {
      const e     = s.sport_event!
      const ctx   = e.sport_event_context
      const names = (e.competitors ?? []).map(c => c.name ?? c.abbreviation ?? '').filter(Boolean)
      return {
        event_id:     e.id!,
        sport,
        name:         names.length === 2 ? `${names[0]} vs ${names[1]}` : ctx?.competition?.name ?? e.id!,
        season:       ctx?.season?.year ?? String(new Date(e.start_time ?? Date.now()).getUTCFullYear()),
        round:        ctx?.round?.name ?? null,
        scheduled_at: e.start_time ? new Date(e.start_time).toISOString() : null,
        source:       'sportradar' as ProviderId,
      }
    })
}

/** Finds one event in a cached daily summaries document. */
export function findSportradarSummary(payload: unknown, eventId: string): SrSummary | null {
  return srSummaries(payload).find(s => s.sport_event?.id === eventId) ?? null
}

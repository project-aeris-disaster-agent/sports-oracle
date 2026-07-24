// src/lib/cache-key.ts
// One definition of the cache qualifier for every endpoint.
//
// This exists because REST and MCP used to compute cache keys independently. Any
// disagreement between them means the same upstream document gets cached twice
// under different keys — paying for it twice and halving the hit rate — and the
// divergence is invisible until someone reads the quota bill. Both surfaces now
// call this.
//
// The qualifier is the part of the cache key that varies per request:
//   {sport}:{dataType}:{qualifier}

export interface QualifierArgs {
  season?:      string
  date?:        string
  week?:        string
  round?:       string
  game_id?:     string
  team_id?:     string
  race_id?:     string
  session_key?: string
  fixture_id?:  string
  epoch_day?:   string
}

/** Sports whose schedule/scores feeds are keyed by date rather than by season. */
export const DATE_SCOPED = ['tennis', 'mma']

/** Sports whose live feed is league-wide, with no per-game id. */
export const FEED_WIDE = ['tennis', 'mma', 'f1', 'dota2']

export function qualifierFor(sport: string, path: string, a: QualifierArgs): string {
  // Soccer is fixture-keyed rather than date- or season-keyed: TxLINE addresses
  // everything by fixtureId, and its fixture list is a rolling window anchored
  // on an epoch day.
  if (sport === 'soccer') {
    switch (path) {
      case 'schedule': case 'events':          return a.epoch_day ?? a.date ?? ''
      case 'scores': case 'odds':
      case 'verify':  case 'resolve':          return a.fixture_id ?? 'missing'
      default:                                  return a.fixture_id ?? a.date ?? ''
    }
  }

  // Dota 2's feed is a rolling window of recent professional matches, not a
  // season document. Keying it by season would mint a new entry each January for
  // a feed that only ever has one current version, and — worse — the warm job and
  // the resolver would then have to agree on a season string to land on the same
  // key. A literal removes that failure mode entirely.
  if (sport === 'dota2') {
    switch (path) {
      case 'schedule': case 'events':  return 'pro'
      case 'live':                     return 'all'
      case 'resolve':                  return a.game_id ?? 'missing'
      default:                          return a.season ?? ''
    }
  }

  switch (path) {
    case 'schedule':
      return DATE_SCOPED.includes(sport) ? (a.date ?? '') : (a.season ?? '')

    case 'scores':
      return a.date ?? ''

    case 'standings':
      // Tennis /standings returns current ATP/WTA rankings, which are not
      // season-scoped — keying them by season would cache a new copy per year
      // for a document that only ever has one current version.
      return sport === 'tennis' ? 'current' : (a.season ?? '')

    case 'roster':
      return (sport === 'nascar' ? a.race_id : a.team_id) ?? 'missing'

    case 'changes':
    case 'transactions':
      // One entry per calendar day. A closed day's log is immutable, so those
      // entries are written with a week-long TTL and never refetched — see the
      // adaptive TTL in the /transactions route.
      return a.date ?? ''

    case 'free-agents':
      // League-wide with no parameters — one entry, not one per season. Keying it
      // by season would cache a fresh 725KB copy per year of a document that only
      // ever has one current version.
      return 'league'

    case 'teams':
      return 'hierarchy'

    case 'live':
      if (!FEED_WIDE.includes(sport)) return a.game_id ?? 'missing'
      return sport === 'f1' ? (a.session_key ?? 'latest') : 'all'

    case 'pbp':
      return a.game_id ?? 'missing'

    case 'leaders':
      return a.season ?? ''

    case 'injuries':
      // NFL scopes injuries by week; every other league publishes one league-wide
      // feed, so they share a single entry rather than one per season.
      return sport === 'nfl' ? `${a.season}-w${a.week ?? '1'}` : 'league'

    case 'depth-chart':
      return `${a.season}-w${a.week ?? '1'}`

    case 'events':
      return a.season ?? ''

    case 'resolve':
    case 'qualifying':
      return `${a.season}-${a.round ?? '1'}`

    default:
      return a.season ?? ''
  }
}

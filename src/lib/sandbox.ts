// src/lib/sandbox.ts
// Synthetic data for the free Scout tier.
//
// The point is integration rehearsal: an agent built against sandbox output
// should run unchanged against live data once the key is upgraded. So the shapes
// here mirror the real upstream payloads field-for-field — same nesting, same key
// names, same types. Only the values are invented.
//
// Nothing in this file touches the upstream provider, so Scout costs zero quota.
//
// Output is deterministic: the same request returns the same payload, because an
// agent debugging against data that changes every poll cannot tell its own bug
// from ours.

const TEAMS: Record<string, Array<[string, string, string]>> = {
  nba:  [['Atlantic City', 'Voltage', 'ACV'], ['Cascade', 'Summit', 'CAS'], ['Delta', 'Current', 'DLT'], ['Harbor', 'Kraken', 'HBK']],
  nhl:  [['Northwind', 'Glaciers', 'NWG'], ['Ironbridge', 'Forge', 'IRF'], ['Bayside', 'Mariners', 'BSM'], ['Summit', 'Wolves', 'SMW']],
  nfl:  [['Redstone', 'Miners', 'RSM'], ['Gulfport', 'Admirals', 'GPA'], ['Highland', 'Rangers', 'HLR'], ['Verde', 'Pumas', 'VRP']],
  mlb:  [['Riverton', 'Sluggers', 'RVS'], ['Copper Hill', 'Diggers', 'CHD'], ['Seabrook', 'Gulls', 'SBG'], ['Fairview', 'Nine', 'FVN']],
  wnba: [['Lakeshore', 'Comets', 'LSC'], ['Granite', 'Peaks', 'GRP'], ['Meridian', 'Aces', 'MDA'], ['Sunport', 'Blaze', 'SPB']],
}

const PLAYERS = [
  'A. Reyes', 'J. Okafor', 'M. Lindqvist', 'D. Whitfield', 'R. Nakamura',
  'T. Bennett', 'K. Ferreira', 'S. Duval', 'C. Mbeki', 'P. Novak',
]

// Expansions of the initials above. The roster-movement feeds return full_name,
// first_name, last_name and abbr_name as separate fields, so an integration that
// parses names needs all four present — not one abbreviated string.
const FIRST_NAMES = [
  'Andres', 'Jelani', 'Mikael', 'Darius', 'Ren',
  'Tobias', 'Kai', 'Sebastien', 'Chidi', 'Petr',
]

/** The four name fields Sportradar returns for a player, from one index. */
function person(i: number) {
  const abbr  = PLAYERS[i % PLAYERS.length]
  const first = FIRST_NAMES[i % FIRST_NAMES.length]
  const last  = abbr.slice(abbr.indexOf(' ') + 1)
  return {
    full_name:  `${first} ${last}`,
    first_name: first,
    last_name:  last,
    abbr_name:  abbr.replace(' ', ''),   // live shape is "D.Cook", no space
  }
}

/** Stable pseudo-random in [0,1) derived from a string — keeps output repeatable. */
function seeded(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic UUID-shaped id, so ids look real and stay stable across calls. */
function fakeId(rnd: () => number): string {
  const hex = '0123456789abcdef'
  const pick = () => hex[Math.floor(rnd() * 16)]
  const block = (n: number) => Array.from({ length: n }, pick).join('')
  return `${block(8)}-${block(4)}-${block(4)}-${block(4)}-${block(12)}`
}

function teamsFor(sport: string, rnd: () => number) {
  const src = TEAMS[sport] ?? TEAMS.nba
  return src.map(([market, name, alias]) => ({
    id: fakeId(rnd), name, market, alias,
    sr_id: `sr:team:${Math.floor(rnd() * 90000) + 10000}`,
  }))
}

export function isSandboxSport(sport: string): boolean {
  return sport in TEAMS || ['tennis', 'mma'].includes(sport)
}

/**
 * Builds a synthetic payload matching the live shape for a sport/dataType.
 * `qualifier` (a date, season or game id) is folded into the seed so different
 * requests return different — but individually stable — data.
 */
export function sandboxPayload(
  sport: string,
  dataType: string,
  qualifier: string
): Record<string, unknown> {
  const rnd   = seeded(`${sport}:${dataType}:${qualifier}`)
  const teams = teamsFor(sport, rnd)
  const today = new Date().toISOString().split('T')[0]

  const game = (i: number) => {
    const home = teams[i % teams.length]
    const away = teams[(i + 1) % teams.length]
    const closed = rnd() > 0.5
    return {
      id: fakeId(rnd),
      status: closed ? 'closed' : 'scheduled',
      scheduled: `${qualifier.match(/^\d{4}-\d{2}-\d{2}$/) ? qualifier : today}T${18 + (i % 4)}:00:00Z`,
      home_points: closed ? Math.floor(rnd() * 40) + 85 : undefined,
      away_points: closed ? Math.floor(rnd() * 40) + 85 : undefined,
      venue: { id: fakeId(rnd), name: `${home.market} Arena`, city: home.market, country: 'USA' },
      home: { id: home.id, name: home.name, alias: home.alias, market: home.market },
      away: { id: away.id, name: away.name, alias: away.alias, market: away.market },
    }
  }

  switch (dataType) {
    case 'teams':
      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        conferences: [{
          id: fakeId(rnd), name: 'Eastern', alias: 'EAST',
          divisions: [{ id: fakeId(rnd), name: 'Atlantic', alias: 'ATL', teams }],
        }],
      }

    case 'schedule':
      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        season: { id: fakeId(rnd), year: 2025, type: 'REG' },
        games: Array.from({ length: 12 }, (_, i) => game(i)),
      }

    case 'scores':
      return {
        date: qualifier,
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        games: Array.from({ length: 4 }, (_, i) => game(i)),
      }

    case 'standings':
    case 'rankings':
      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        season: { id: fakeId(rnd), year: 2025, type: 'REG' },
        conferences: [{
          id: fakeId(rnd), name: 'Eastern', alias: 'EAST',
          divisions: [{
            id: fakeId(rnd), name: 'Atlantic', alias: 'ATL',
            teams: teams.map((t, i) => ({
              ...t,
              wins: 50 - i * 6, losses: 20 + i * 6,
              win_pct: +(0.7 - i * 0.08).toFixed(3),
              points_for: 4200 - i * 90, points_against: 3900 + i * 70,
            })),
          }],
        }],
      }

    case 'injuries':
      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        teams: teams.slice(0, 3).map(t => ({
          ...t,
          players: PLAYERS.slice(0, 2 + Math.floor(rnd() * 2)).map(full => ({
            id: fakeId(rnd), full_name: full,
            position: ['G', 'F', 'C', 'QB', 'P'][Math.floor(rnd() * 5)],
            injuries: [{
              id: fakeId(rnd),
              comment: 'Synthetic entry for integration testing.',
              desc: ['Ankle', 'Hamstring', 'Knee', 'Shoulder'][Math.floor(rnd() * 4)],
              status: ['Out', 'Questionable', 'Probable', 'Day To Day'][Math.floor(rnd() * 4)],
              start_date: today, update_date: today,
            }],
          })),
        })),
      }

    case 'roster':
      return {
        ...teams[0],
        players: PLAYERS.map((full, i) => ({
          id: fakeId(rnd), full_name: full, jersey_number: String(i + 4),
          position: ['G', 'F', 'C'][i % 3],
          height: 72 + (i % 12), weight: 180 + i * 4,
          experience: String(i % 12),
        })),
      }

    // ── Roster movement ──────────────────────────────────────────────────────
    // Shapes mirror the live feeds field-for-field, including the nesting: a
    // transaction is a `transfers` array hanging off the player it moved, not a
    // flat event list. from_team is present only on a trade, exactly as upstream.
    case 'transfers': {
      const TYPES: Array<[string, string]> = [
        ['Signed', 'SGN'], ['Traded', 'TRD'], ['Waived', 'WVD'],
        ['Assigned', 'ASG'], ['Released', 'REL'],
      ]
      // The qualifier is the requested date, so a given day always returns the
      // same synthetic wire.
      const day     = /^\d{4}-\d{2}-\d{2}$/.test(qualifier) ? qualifier : today
      const teamRef = (t: { id: string; name: string; market: string }) => ({
        id: t.id, name: t.name, market: t.market,
        reference: String(1610612700 + Math.floor(rnd() * 60)),
      })

      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        start_time: `${day}T00:00:00+00:00`,
        end_time:   `${day}T23:59:59+00:00`,
        players: Array.from({ length: 3 }, (_, i) => {
          // abbr_name is deliberately dropped: the free-agent feed carries it, the
          // transaction feed does not. Emitting a field live data won't return is
          // exactly the drift this file exists to prevent.
          const { abbr_name, ...p } = person(i)
          void abbr_name
          const pos  = ['G', 'F', 'C'][i % 3]
          const to   = teams[i % teams.length]
          const from = teams[(i + 1) % teams.length]
          const [transaction_type, transaction_code] = TYPES[Math.floor(rnd() * TYPES.length)]
          return {
            id: fakeId(rnd), ...p,
            position: pos, primary_position: ['PG', 'SF', 'C'][i % 3],
            sr_id:     `sr:player:${Math.floor(rnd() * 900000) + 100000}`,
            reference: String(Math.floor(rnd() * 900000) + 100000),
            transfers: [{
              id: fakeId(rnd),
              desc: `The ${to.market} ${to.name} ${transaction_type.toLowerCase()} ${pos} ${p.full_name}.`,
              effective_date: day,
              last_modified:  `${day}T21:16:52+00:00`,
              transaction_type, transaction_code,
              ...(transaction_code === 'TRD' ? { from_team: teamRef(from) } : {}),
              to_team: teamRef(to),
            }],
          }
        }),
      }
    }

    case 'changes': {
      // A change-log entry is a *pointer*, not a document: an id plus the time it
      // was revised. Consumers are meant to refetch what it names, so the ids here
      // are stable across calls for a given day — an agent testing its
      // invalidation loop needs the same id to keep pointing at the same thing.
      const day   = /^\d{4}-\d{2}-\d{2}$/.test(qualifier) ? qualifier : today
      const stamp = (i: number) => `${day}T${String(12 + (i % 10)).padStart(2, '0')}:31:07+00:00`
      const seasonId = fakeId(rnd)

      return {
        league:     { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        start_time: `${day}T05:00:00Z`,
        end_time:   `${day}T04:59:59Z`,
        players: Array.from({ length: 4 }, (_, i) => ({
          id: fakeId(rnd), full_name: person(i).full_name,
          last_modified: stamp(i),
          sr_id: `sr:player:${Math.floor(rnd() * 900000) + 100000}`,
          reference: String(Math.floor(rnd() * 900000) + 100000),
        })),
        schedule: Array.from({ length: 2 }, (_, i) => ({
          id: fakeId(rnd), season_id: seasonId, last_modified: stamp(i),
          sr_id: `sr:match:${Math.floor(rnd() * 900000) + 100000}`,
        })),
        results: Array.from({ length: 2 }, (_, i) => ({
          id: fakeId(rnd), season_id: seasonId, last_modified: stamp(i + 2),
          sr_id: `sr:match:${Math.floor(rnd() * 900000) + 100000}`,
        })),
        standings: teams.map((t, i) => ({
          id: t.id, name: t.name, market: t.market,
          last_modified: stamp(i), sr_id: t.sr_id,
        })),
      }
    }

    case 'free_agents':
      // Ten entries, not the ~1,750 the live NBA feed returns. Sandbox exists to
      // rehearse an integration, and a synthetic payload large enough to matter
      // for egress would be paying a real cost to imitate one.
      return {
        league: { id: fakeId(rnd), name: sport.toUpperCase(), alias: sport.toUpperCase() },
        free_agents: PLAYERS.map((_, i) => ({
          id: fakeId(rnd), status: 'FA', ...person(i),
          height: 72 + (i % 12), weight: 180 + i * 4,
          position: ['G', 'F', 'C'][i % 3], primary_position: ['PG', 'SF', 'C'][i % 3],
          experience:  String(i % 12),
          college:     'Northfield State',
          high_school: 'Northfield Central',
          birth_place: 'Northfield, OH, USA',
          birthdate:   `199${i % 10}-04-28`,
          updated:     `${today}T19:32:12+00:00`,
          rookie_year: 2014 + (i % 8),
        })),
      }

    case 'leaders':
      return {
        season: { id: fakeId(rnd), year: 2025, type: 'REG' },
        categories: ['points', 'rebounds', 'assists'].map(cat => ({
          name: cat, type: 'total',
          ranks: PLAYERS.slice(0, 5).map((full, i) => ({
            rank: i + 1,
            player: { id: fakeId(rnd), full_name: full, position: ['G', 'F', 'C'][i % 3] },
            team: teams[i % teams.length],
            total: Math.floor(rnd() * 500) + 1200 - i * 90,
          })),
        })),
      }

    case 'depth_charts':
      return {
        season: { id: fakeId(rnd), year: 2025, type: 'REG' },
        week: { id: fakeId(rnd), sequence: 1, title: '1' },
        teams: teams.map(t => ({
          ...t,
          offense: ['QB', 'RB', 'WR', 'TE'].map(pos => ({
            position: { name: pos },
            players: PLAYERS.slice(0, 2).map((full, d) => ({
              id: fakeId(rnd), full_name: full, depth: d + 1, position: pos,
            })),
          })),
        })),
      }

    case 'pbp':
      return {
        id: fakeId(rnd), status: 'closed',
        scheduled: `${today}T19:00:00Z`,
        home: teams[0], away: teams[1],
        periods: Array.from({ length: 4 }, (_, p) => ({
          id: fakeId(rnd), number: p + 1, sequence: p + 1,
          events: Array.from({ length: 8 }, (_, e) => ({
            id: fakeId(rnd),
            clock: `${11 - e}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`,
            event_type: ['fieldgoal', 'rebound', 'turnover', 'freethrow'][Math.floor(rnd() * 4)],
            description: 'Synthetic play-by-play event.',
            home_points: p * 25 + e * 2,
            away_points: p * 24 + e * 2,
          })),
        })),
      }

    case 'live':
      return {
        id: fakeId(rnd), status: 'inprogress',
        clock: '07:32', quarter: 3,
        scheduled: `${today}T19:00:00Z`,
        home: { ...teams[0], points: 78 },
        away: { ...teams[1], points: 74 },
      }

    default:
      return {
        note: `No sandbox fixture defined for "${dataType}".`,
        sport, dataType, qualifier,
      }
  }
}

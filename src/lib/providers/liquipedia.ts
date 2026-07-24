// src/lib/providers/liquipedia.ts
// Liquipedia MediaWiki API — community esports wiki, content under CC-BY-SA 3.0.
// Covers 30+ titles, which makes it the obvious candidate for the esports titles
// that have no open match-level feed.
//
// REGISTERED BUT OFFLINE. The reason is specific and was established by probing
// the live API, not assumed — see below.
//
// ─── What was probed, and what it showed ─────────────────────────────────────
// The plan was to read final tournament placements from each event page's prize
// pool table via action=parse&prop=wikitext. Two pages were checked:
//
//   counterstrike / Perfect World/Major/2024/Shanghai
//     |{{Slot|place=1|usdprize=500,000|qualified1=true}}
//     |{{Slot|place=2|usdprize=170,000}}
//     |{{Slot|place=3-4|usdprize=80,000}}
//
//   dota2 / The International/2024
//     |{{Slot|place=1|usdprize={{formatnum:{{#expr:{{#var:prizepool_total}}…
//
// Two blockers, both fatal to that approach:
//
//   1. NO TEAM NAMES. The prize pool table describes the prize *structure* —
//      what a placement pays — not who achieved it. There is no team, opponent
//      or participant parameter on these slots at all. Placement-to-team
//      attribution lives in the bracket templates, and reconstructing those
//      across wikis is the tar pit this was scoped to avoid.
//   2. UNEVALUATED MARKUP. Prizes are computed at render time by MediaWiki
//      parser functions ({{#expr:}}, {{#var:}}, transcluded subpages). Raw
//      wikitext returns the expression, not the value. Reading it correctly
//      would mean implementing a template engine.
//
// ─── What that leaves ────────────────────────────────────────────────────────
// The structured placement data does exist — in Liquipedia's LPDB API, whose
// free tier is educational / non-commercial only and therefore cannot back a
// paid product. The remaining option is action=parse&prop=text, which returns
// rendered HTML with the templates evaluated and teams attached. That is worth
// evaluating, but it is a different integration (HTML parsing, and a terms
// question about rendered output) and it is not what this file implements.
//
// Nothing here is wired to a live sport. It is registered so the routing table
// publishes the option and the reason it is not taken, which is the same
// treatment openligadb gets.
//
// ─── If this is ever switched on, two things are mandatory ───────────────────
//   Rate limit: 1 request per 2 seconds, GLOBAL. Not per-account. `politeRpm`
//   below is a per-account gateway limit (see gateway.ts) and does NOT satisfy
//   this on its own, and neither does an in-process counter — Vercel scales
//   instances horizontally, so module scope is per-instance, not per-deployment.
//   The only honest way to hold it is to fetch exclusively from a single
//   serialised cron runner and serve the request path from cache.
//
//   Licence: CC-BY-SA is share-alike. Facts (who placed where, when) carry no
//   obligation; the wiki's raw text is copyrighted expression. `project` below
//   therefore exists to guarantee wikitext is never written to sports_cache —
//   it must parse to facts or store nothing.

import type { Provider, ProviderAuth } from './types'

export const LIQUIPEDIA_ATTRIBUTION = {
  source:     'Liquipedia',
  url:        'https://liquipedia.net',
  license:    'CC-BY-SA 3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
} as const

/** 1 req / 2 s expressed as a per-minute figure. See the caveat above. */
const POLITE_RPM = 30

function liquipediaAuth(): ProviderAuth {
  // Their terms require an identifying User-Agent carrying a contact address.
  // A default that does not identify us would be a terms violation, so this is
  // required rather than defaulted.
  const ua = process.env.LIQUIPEDIA_USER_AGENT
  if (!ua) throw new Error('LIQUIPEDIA_USER_AGENT is not set (must include a contact email)')
  return { headers: { 'User-Agent': ua } }
}

export const liquipedia: Provider = {
  id:          'liquipedia',
  label:       'Liquipedia',
  homepage:    'https://liquipedia.net',
  attribution: 'Esports tournament data via Liquipedia, CC-BY-SA 3.0 '
             + '(https://creativecommons.org/licenses/by-sa/3.0/)',
  base:        'https://liquipedia.net',

  endpoints: {
    // {wiki} is the per-title wiki slug: dota2, counterstrike, valorant,
    // leagueoflegends, rocketleague, starcraft2, overwatch, rainbowsix, …
    standings: '/{wiki}/api.php?action=parse&page={page}&prop=wikitext&format=json&redirects=true',
  },

  metered:       false,
  license:       'open',
  status:        'offline',
  offlineReason: 'Probed and not usable as designed: tournament prize-pool wikitext '
               + 'carries prize structure but no team attribution, and prize values are '
               + 'unevaluated MediaWiki template expressions. Placement-to-team data '
               + 'requires either bracket reconstruction or the LPDB API, whose free '
               + 'tier is non-commercial. No placement parser is wired.',
  // A community-edited wiki is a strong secondary reference, not a governing
  // body. False caps anything sourced here at `provisional`, enforced by the
  // pipeline rather than remembered — see resolution.ts.
  authoritative: false,
  politeRpm:     POLITE_RPM,
  auth:          liquipediaAuth,

  // Fails closed. Reached only if this provider is switched to live before a
  // parser exists, and in that case storing nothing is correct: caching raw
  // wikitext is the one outcome the licence analysis above rules out.
  project() {
    throw new Error(
      'liquipedia: no placement parser is implemented. Raw wikitext must never be '
      + 'cached or served — see the licence note in providers/liquipedia.ts.'
    )
  },
}

# Esports Build Plan

Implementation plan for the esports vertical described in `ESPORTS_ORACLE.md` (the artifact),
adapted to the architecture that actually exists in this repo today.

Status: **IMPLEMENTED.** Typecheck clean; 101 behavioural assertions passing.

> ### Two findings from the build that changed the outcome
>
> **1. Liquipedia does not carry the data the artifact assumed.** The plan was to read
> tournament placements from each event page's prize-pool table. Probing the live MediaWiki
> API on two wikis showed those `{{Slot}}` templates carry prize *structure* and no team
> attribution at all — plus prize values are unevaluated `{{#expr:}}` markup. Placement→team
> data requires bracket reconstruction (explicitly out of scope) or the LPDB API (free tier is
> non-commercial). **Liquipedia is therefore registered offline, and `cs2` / `starcraft2` /
> `rocketleague` are offline rather than `limited`.** The exact wikitext is recorded in
> [providers/liquipedia.ts](src/lib/providers/liquipedia.ts).
>
> **2. OpenDota's API was down (HTTP 522) for the whole build**, so the Dota 2 field mapping
> is verified against its documented schema and 55 logic assertions, but **not** against a live
> response. Every other provider in this repo was live-probed, so `dota2` ships as `limited`
> with the caveat in `statusNote`, not `online`. Promotion is a one-word change and the exact
> check is written at the entry in [capabilities.ts](src/lib/capabilities.ts).
>
> Net: **1 title serving, 13 registered and tagged** — see §2.

---

## 1. Headline: the artifact describes a system we already built

The artifact was written against the older `CLAUDE.md` shape (Sportradar wrapper, per-sport
route files). The build has since become a **data router** with a normalised resolution
surface. Almost every mechanism the artifact proposes to build already exists and is in
production use for F1 and soccer.

| Artifact proposes | Already exists | Where |
|---|---|---|
| `esports_resolutions` table | `sports_cache` — the sport CHECK constraint was deliberately dropped so new sports need **no migration** | `20250101000008_provider_registry.sql` |
| Status enum `scheduled/live/provisional/final/disputed` | `ResolutionStatus` = `scheduled/live/provisional/official/void` | `src/lib/resolution.ts:49` |
| "never settle on provisional" contract | `official` flag + `meta.settleable` + `X-Settleable` header | `src/app/api/v1/[sport]/resolve/route.ts:88` |
| Infinite TTL for finalised results | 30-day TTL promotion on first official read | `resolve/route.ts:22,66` |
| `/esports/{game}/resolution` | `/api/v1/{sport}/resolve?event_id=` | existing route |
| `/esports/{game}/matches` | `/api/v1/{sport}/events` | existing route |
| Provider abstraction | `Provider` interface w/ `license`, `metered`, `authoritative`, `politeRpm` | `src/lib/providers/types.ts` |
| Attribution in responses | `meta.attribution` on every `serveCached` response | `src/lib/serve.ts:193` |
| Per-source finality gating | `authoritative: boolean` — non-authoritative sources are capped at `provisional` | `types.ts:103` |
| Sync cron + merge RPC | `cache-warmup.yml` + `fetchAndCache` | existing |

**Consequence: this ships with zero new route files, zero new tables, and zero new RPCs.**
It is three provider files, four edits to existing config, one seed migration, one cron entry.

### What I am deliberately NOT building from the artifact

**1. The `esports_resolutions` table and `merge_resolution_report()`.**
That machinery exists to fold reports from multiple providers into one mutable record and
recompute a status. It is ~120 lines of PL/pgSQL and a second source of truth alongside
`sports_cache`.

It is only necessary if no single source is trustworthy. For Dota 2, one is: OpenDota's
`radiant_win` is read from Valve's own WebAPI — the publisher's record of the match, i.e. the
governing body. That is precisely what `authoritative: true` means in this codebase (Jolpica
holds the same status for F1 for the same reason).

The artifact's real safety insight — *don't trust the first report* — survives, but as a pure
function instead of a table:

```
official = radiant_win is present AND (now - match_end_time) > CONFIRMATION_WINDOW (6h)
```

Same 6-hour ageing rule, same guarantee, no table, no cron-driven state machine, no merge
function. It costs nothing because caching already makes the re-read free.

**2. The `disputed` status.** With one authoritative source per title it is unreachable. And
`ResolutionStatus` is a **shipped public API contract** for F1 and soccer — widening the enum
forces every existing consumer to handle a variant they will never receive. If we later add a
corroborating source and it disagrees, that maps to `official: false` plus a `notes[]` entry,
which the contract already supports.

**3. The in-process Liquipedia throttle.** This one is a correctness bug, not a preference.
The artifact's `let lastCall = 0` module-scope throttle **does not work on Vercel**: each
serverless instance has its own module scope and instances scale out horizontally under load,
so N concurrent instances issue N concurrent requests. `politeRpm` doesn't fix it either —
that limiter is keyed per-account (`gateway.ts:266`), not globally.

Liquipedia's 1-req/2s is a **terms-of-use obligation**, so it needs to actually hold.
Design instead: **Liquipedia is fetched only by the warm cron** — a single GitHub Actions
runner, serialised, where a sleep between calls genuinely works. The request path serves from
`sports_cache` only. This also satisfies their "cache as long as possible" requirement by
construction rather than by discipline.

---

## 2. The game list, tagged

Uses the existing `SportSpec` tagging vocabulary (`capabilities.ts:36`), which already maps
cleanly onto the ask:

- **`online`** (green) — full match-level resolution, settleable
- **`limited`** (yellow) — incomplete: tournament/placement level only, no match-level source
- **`offline`** (red) — unavailable: registered and documented, returns 503 with the reason

`entitled: false` keeps a title out of `supportedFor()` and off the granted `sport_mask`, so
offline entries are discoverable without being routable. Same pattern as `nascar` /
`nba_gleague` today.

| Key | Label | Status | Entitled | Default source | Tag rationale |
|---|---|---|---|---|---|
| `dota2` | Dota 2 | 🟡 limited | ✅ | opendota | Match-level `radiant_win` from Valve WebAPI — settleable. `limited` only because the live probe is outstanding (see banner). |
| `lol` | League of Legends | 🔴 offline | ❌ | riot *(offline)* | Publisher-locked. Riot production keys are not granted for redistribution. |
| `valorant` | Valorant | 🔴 offline | ❌ | riot *(offline)* | Publisher-locked — same Riot policy. |
| `tft` | Teamfight Tactics | 🔴 offline | ❌ | riot *(offline)* | Publisher-locked — same Riot policy. |
| `cs2` | Counter-Strike 2 | 🔴 offline | ❌ | liquipedia *(offline)* | HLTV has no licence; Liquipedia carries no parseable placements. |
| `starcraft2` | StarCraft II | 🔴 offline | ❌ | liquipedia *(offline)* | Liquipedia-only; no parseable placements. |
| `rocketleague` | Rocket League | 🔴 offline | ❌ | liquipedia *(offline)* | Liquipedia-only; no parseable placements. |
| `overwatch` | Overwatch 2 | 🔴 offline | ❌ | liquipedia *(offline)* | No public API. Liquipedia-only. |
| `rainbow6` | Rainbow Six Siege | 🔴 offline | ❌ | liquipedia *(offline)* | No public API. Liquipedia-only. |
| `cod` | Call of Duty | 🔴 offline | ❌ | liquipedia *(offline)* | Activision withdrew its public API. |
| `mlbb` | Mobile Legends | 🔴 offline | ❌ | liquipedia *(offline)* | Moonton has no public API. |
| `apex` | Apex Legends | 🔴 offline | ❌ | liquipedia *(offline)* | Battle royale. Source is the blocker, not the format — see note below. |
| `pubg` | PUBG | 🔴 offline | ❌ | liquipedia *(offline)* | Battle royale — same. |
| `fortnite` | Fortnite | 🔴 offline | ❌ | liquipedia *(offline)* | Battle royale — same. |

**Battle-royale note.** The existing `Competitor` contract already fits BR scoring without
change: `position` = final placement, `points` = tournament points, `winner` = the P1 team.
The reason apex/pubg/fortnite are offline is source verification, not a modelling gap — worth
recording so nobody later concludes the contract needs widening.

**Namespace decision: flat keys, not `esports/{game}`.** The artifact proposed
`/api/v1/esports/dota2/resolution` and an `esports:*` access mask. Flat `dota2` reuses the
existing `[sport]` route tree, `sport_mask text[]`, gateway mask check, cache-key format, and
budget rows — all unchanged. The nested form needs a new route directory and a gateway change
for wildcard masks. Add one optional `group?: 'esports'` field to `SportSpec` purely so the
dashboard can render a section header.

---

## 3. Build steps

Ordered so each step is independently verifiable. Steps 1–5 are a shippable product
(Dota 2, settleable). Steps 6–8 are additive.

### Step 1 — Register the provider IDs
`src/lib/providers/types.ts` — extend the `ProviderId` union with `'opendota' | 'liquipedia' | 'riot'`.
Three lines. No other change to this file.

### Step 2 — `src/lib/providers/opendota.ts` *(new)*
Plain `Provider` object, same shape as `jolpica.ts`. Not the artifact's bespoke class — the
`fetch`/`buildUrl`/timeout/budget pipeline in `upstream.ts` already handles everything its
custom `fetch()` reimplements.

```ts
export const opendota: Provider = {
  id: 'opendota', label: 'OpenDota',
  homepage: 'https://www.opendota.com',
  attribution: 'Dota 2 match data via OpenDota (MIT)',
  base: 'https://api.opendota.com/api',
  endpoints: {
    schedule: '/proMatches',            // event registry + primary resolution feed
    results:  '/matches/{match_id}',    // single-match confirmation
    live:     '/live',
  },
  metered: false,
  license: 'open',
  status: 'live',
  authoritative: true,   // radiant_win originates from Valve's WebAPI
  politeRpm: 50,         // free tier is 60/min; leave headroom
  auth: () => process.env.OPENDOTA_API_KEY
    ? { query: { api_key: process.env.OPENDOTA_API_KEY } }
    : {},
}
```

Only three endpoints. `/heroes`, `/players`, `/benchmarks`, `/explorer` are analytics — out of
scope, exactly as the artifact argues.

### Step 3 — `src/lib/resolution.ts`: add `fromOpenDota` + `eventsFromOpenDota`
Mirrors the existing `fromJolpica` / `fromTxLine` mappers. Two competitors (radiant, dire),
`position` 1/2, `points` = kill score.

The finality rule lives here as a pure function:

```ts
const DOTA_CONFIRMATION_WINDOW = 6 * 60 * 60 * 1000

// radiant_win is the ONE resolution field. `undefined` means unresolved,
// never "radiant lost" — typeof-check it, don't coerce.
const resolved = typeof m.radiant_win === 'boolean'
const endedAt  = (m.start_time + m.duration) * 1000
const official = resolved && Date.now() - endedAt > DOTA_CONFIRMATION_WINDOW
```

`status` = `official` → `'official'`, resolved-but-inside-window → `'provisional'`,
otherwise `'live'` / `'scheduled'`. Add `'dota2'` to `RESOLVABLE`.

Carry a `notes[]` entry while provisional stating the match is inside the confirmation window
— this is what makes the ageing rule visible to an integrator rather than implicit, and it
replaces the artifact's `confirmed_by` array.

### Step 4 — `src/lib/resolve-dispatch.ts`: add the `dota2` resolver
One entry in `RESOLVERS`, alongside `f1` and `soccer`. No route edits.

```ts
const dota2: SportResolver = {
  idFormat: 'a numeric OpenDota match id, e.g. 7891234567',
  events:  (sport, q) => /* getOrFetch schedule → eventsFromOpenDota */,
  resolve: (sport, id) => /* /proMatches scan first, /matches/{id} fallback */,
}
```

**Resolve from `/proMatches` first.** It is one small cached document covering ~100 recent pro
matches and serves every recent lookup from a single cache entry. Fall back to
`/matches/{id}` only for older matches. This matters: `/matches/{id}` returns full telemetry
(hundreds of KB) and caching it per match is exactly the Supabase-500MB pressure the artifact
warns about. The soccer resolver already uses this enrich-from-registry pattern
(`resolve-dispatch.ts:99-117`) — same shape, established precedent.

### Step 5 — `src/lib/providers/index.ts` + `capabilities.ts`
`ROUTING`: `dota2: { default: opendota, alternates: [liquipedia] }`, plus the rest of the
table from §2. `capabilities.ts`: the `DECLARED` entries with `status` / `entitled` /
`statusNote` / `group: 'esports'`, exposing `EVENTS` and `RESOLVE` for `dota2`.

`sources` is derived from `ROUTING`, so provenance cannot drift. `toolCatalog()` derives MCP
tools from endpoint paths — `resolve` and `events` already exist, so **the MCP surface picks
esports up with no change at all.**

> **Ship gate.** After step 5, `/api/v1/dota2/events` and `/api/v1/dota2/resolve?event_id=…`
> work end to end, tier-gated, cached, attributed, and MCP-exposed. Verify a completed match
> reports `provisional` inside 6h and `official` after, and that the 30-day TTL promotion fires.

### Step 6 — `src/lib/providers/riot.ts` *(new, offline stub)*
~12 lines: `status: 'offline'`, `offlineReason` naming the redistribution policy. This is
documentation that lives in the API — an integrator asking "why no LoL?" gets a 503 with the
actual reason instead of a 404. `types.ts:41` already argues for exactly this.

### Step 7 — `src/lib/providers/liquipedia.ts` *(new)*
Standard `Provider`. The MediaWiki call fits `buildUrl` as-is because endpoint templates may
carry their own query string (`types.ts:58`):

```
base:      'https://liquipedia.net'
endpoints: { standings: '/{wiki}/api.php?action=parse&page={page}&prop=wikitext&format=json&redirects=true' }
auth:      () => ({ headers: { 'User-Agent': process.env.LIQUIPEDIA_USER_AGENT! } })
license:   'open'   // CC-BY-SA 3.0
authoritative: false   // community-edited — caps at `provisional` automatically
```

`auth.headers` is already merged into the fetch (`upstream.ts:130`), so the mandatory
identifying User-Agent needs no new plumbing.

`authoritative: false` is the important line: it means Liquipedia data can never be marked
settleable, which is the honest position for a wiki and is enforced by the type system rather
than remembered.

Tournament placements map to the existing `standings` dataType — **no new endpoint path**, so
the artifact's `/tournament` becomes `/api/v1/cs2/standings?page=…`.

Parse **prize-pool placement tables only.** No bracket reconstruction in v1 — the artifact is
right that bracket templates vary per wiki and it is a tar pit.

**Never cache or serve the raw wikitext.** This is a licence constraint, not a preference —
see §7.2. The artifact's provider returns `{ wikitext, attribution }` as its payload, and the
normal pipeline (`getOrFetch` / `serveCached`) caches and serves the raw upstream document.
Combined, that would put verbatim CC-BY-SA prose into `sports_cache` and hand it to paying
callers. Liquipedia must therefore **parse to a placement array at fetch time** and cache only
that — the extracted facts (team, placement, prize, date), never the source text.

This is the one place the esports vertical cannot use the plain pass-through path, so
`cs2`/`starcraft2`/`rocketleague` expose `standings` through the resolver route only.

### Step 8 — Cron: `.github/workflows/esports-warm.yml` *(new)*
Two jobs, different cadences:

- **Dota 2**, every 15 min: warm `/proMatches` and `/live`. Straight `curl` to the existing
  `/api/internal/warm` route — no new sync route, no `merge_resolution_report`.
- **Liquipedia**, hourly, `max-parallel: 1`, with `sleep 2` between pages. This is the only
  place Liquipedia is ever fetched, which is what makes the 1-req/2s obligation actually hold.

### Step 9 — `supabase/migrations/20250101000010_esports.sql` *(new)*
Seed only — **no schema change**, following `20250101000009_soccer_and_alternates.sql`
verbatim as the template:
- `sport_quota` rows for all 14 keys (`metered: false`, `monthly_limit: 0`), so the operator
  dashboard and `budget_status` list them.
- `sport_mask` backfill granting `dota2`, `cs2`, `starcraft2`, `rocketleague` to keys that
  already hold the full entitled set. Offline titles are **not** granted — same conservative
  rule 0009 applied to `football`.

### Step 10 — `.env.example`
`OPENDOTA_API_KEY` (optional — raises limits) and `LIQUIPEDIA_USER_AGENT` (required, must
carry a real contact email per their terms).

---

## 4. Change surface — as built

**New (5):** [providers/opendota.ts](src/lib/providers/opendota.ts),
[providers/liquipedia.ts](src/lib/providers/liquipedia.ts),
[providers/riot.ts](src/lib/providers/riot.ts),
[migrations/20250101000010_esports.sql](supabase/migrations/20250101000010_esports.sql),
[.github/workflows/esports-warm.yml](.github/workflows/esports-warm.yml)

**Edited (7):** [providers/types.ts](src/lib/providers/types.ts),
[providers/index.ts](src/lib/providers/index.ts),
[capabilities.ts](src/lib/capabilities.ts), [resolution.ts](src/lib/resolution.ts),
[resolve-dispatch.ts](src/lib/resolve-dispatch.ts), [cache-key.ts](src/lib/cache-key.ts),
[upstream.ts](src/lib/upstream.ts), plus `.env.example`

**Untouched, as planned:** every route file, `serve.ts`, `gateway.ts`, the MCP route, all
existing migrations and tables. No new routes, no new tables, no new RPCs.

### Two departures from the plan, both deliberate

**`upstream.ts` and `cache-key.ts` were edited** — the plan did not anticipate either.

`upstream.ts` gained a `project` hook on the `Provider` contract, applied immediately after
the JSON parse so the narrowed shape is what reaches `sports_cache`. It earns its place twice
over: OpenDota's `/matches/{id}` measured **112× larger** than the resolution slice it
contains (23.3KB → 0.21KB on a representative payload), and it is the mechanism that
guarantees Liquipedia wikitext can never be written to the database if that provider is ever
switched on. Without it, both the size and the licence problem would have had to be solved by
bypassing the shared cache path.

`cache-key.ts` gained a `dota2` block because `/proMatches` is a rolling feed, not a
season-scoped document. Keying it by season would mint a dead entry every January and — worse
— require the warm job and the resolver to independently agree on a season string to land on
the same key.

### One bug the verification caught

The Dota 2 endpoints initially inherited the shared `EVENTS` spec's 1-day TTL. Since
`/api/internal/warm` writes cache entries using the *manifest* TTL, the 15-minute cron would
have written the rolling feed once and then skipped it as fresh for 24 hours — a match that
ended minutes ago would never appear in `/events`, and every settlement would silently fall
through to a per-match fetch. Fixed by overriding the TTLs on the dota2 entry (300s / 600s)
and having `resolve-dispatch.ts` read them via `ttlFor()` instead of keeping its own copy, so
the two cannot drift again.

> **Latent, pre-existing, not fixed:** soccer has the same divergence — `SOCCER_EVENTS_TTL` is
> 3600 while its manifest `EVENTS` spec says 86400. It is currently harmless only because
> soccer is absent from the `cache-warmup.yml` matrix. Adding it there would trip the bug.
> Left alone as out of scope; flagging it rather than changing soccer's caching silently.

## 4c. Follow-on: sorting, badges, and a status bug they exposed

Adding 14 titles took the panel to 26 sports rendered in **declaration order** — authoring
history, not meaning — which buried the ones that serve among the ones that don't.

**Ordering and badges are derived in [capabilities.ts](src/lib/capabilities.ts)**, not in the
component, so the landing page, dashboard and anything built later stay consistent:

- `groupedSports(statusOf)` splits into **SPORTS** / **ESPORTS** sections, each sorted
  status → entitled → endpoint count → label. It takes a status resolver, so the live probe
  results order the list rather than the declared values.
- `badgesFor(sport)` returns card indicators: **SETTLES**, **IN-PLAY**, **OPEN** / **LICENSED**
  / **UNVERIFIED TERMS**, **SCARCE**. All derived — a badge cannot contradict the endpoint
  table. `SETTLES` requires *both* a `/resolve` endpoint **and** an authoritative default
  source; badging a non-authoritative `/resolve` as settleable is the most damaging thing this
  panel could get wrong.
- The licence badge is suppressed on unentitled sports. It was putting a green **OPEN** chip
  beside a red OFFLINE light on all 13 registered esports titles, which reads as availability.
  Still visible on the expanded SOURCE row.

### The bug this exposed — `derive()` could promote a sport it knew nothing about

[status.ts](src/lib/status.ts) computes live status from **budget/quota alone**. For any
unmetered provider `calls_limit` is 0, so every quota branch is skipped and the sport lands in
the final `else` → `online`, "All endpoints operational".

That silently overrode the manifest. Dota 2 rendered as **OPERATIONAL** on the public page
while OpenDota was returning 522 — precisely the overstatement the `limited` tag existed to
prevent. It would equally have masked any future sport marked `limited` for an unverified
integration.

Fixed by making the declared status a **ceiling**: budget health may degrade a sport, never
promote one. Verified after the fix — 8 operational / 2 limited / 16 offline, with `f1`,
`soccer` and the Sportradar sports unchanged.

## 4b. Verification performed

| What | How | Result |
|---|---|---|
| Whole project | `npx tsc --noEmit` | clean |
| Mapper + projection logic | 55 assertions against fixtures shaped per endpoint | 55/55 |
| Router + capability wiring | 46 assertions incl. regression on nba/nhl/tennis/f1/soccer | 46/46 |
| Liquipedia wikitext | live MediaWiki API, 2 wikis | **negative — see banner** |
| OpenDota field names | live API | **blocked — HTTP 522 throughout** |

Logic coverage worth naming, since these are the ways a resolution oracle mis-settles:
`radiant_win === false` resolves to *dire won* and never to *unresolved*; the 6h boundary
holds at 5.99h and flips at 6.01h; a live match never reports a winner; a Bo3 game emits the
`ONE GAME` series warning so a series market cannot settle on a single map.

---

## 5. Deliberately out of scope

Carried over from the artifact, and I agree with all of it: hero win rates, item builds,
player MMR, telemetry, damage charts. Analytics, not resolution — they bloat the cache against
the 500MB cap and settle nothing.

---

## 6. Two things to document publicly

Both are the artifact's points and they should survive into the API docs verbatim, because
an oracle's credibility is the product:

1. **Dota 2 is the only title with match-level open-source coverage.** CS2 / Rocket League /
   StarCraft II are tournament-level only. LoL / Valorant / TFT are publisher-locked. The
   `status` tag on each sport already says this in-band, but say it in prose too.
2. **The 6-hour ageing rule is weaker than dual-source corroboration.** A single authoritative
   source that has held steady is what `official: true` means for Dota 2. State the rule so a
   conservative agent can apply a stricter threshold of its own.

---

## 7. Decisions and open questions

### 7.1 Decided — register all 14 titles *(confirmed 2026-07-25)*

All 14 keys from §2 go in on one pass. They are rows in a data table (~6 lines each), and
publishing what the router *could* reach is the explicit product argument in `types.ts:41`.
No phased rollout.

### 7.2 Decided — how CC-BY-SA constrains the Liquipedia path

Liquipedia's content is CC-BY-SA 3.0. Two obligations follow, and they shape the build:

**BY (attribution)** — already handled. `Provider.attribution` ships in `meta` on every
response (`serve.ts:193`).

**SA (share-alike) + the "no additional restrictions" clause** — this is the part that
touches the design:

- **Charging is fine.** BY-SA is *not* non-commercial. A paid, staking-gated API over
  Liquipedia-derived data is permitted.
- **You cannot forbid your customers from redistributing it.** The licence bars applying legal
  terms that restrict what it permits. So the API ToS needs a carve-out: the Liquipedia-derived
  portions of a response stay redistributable under CC-BY-SA, even though access is paid.
- **Bare facts are the safe zone.** Copyright protects expression, not facts. "Team Spirit
  placed 1st, $1.2M, 2026-08-14" is a fact and carries no licence obligation on its own.
  Verbatim wikitext is expression and does.

**Therefore:** parse to facts at fetch time, cache and serve only the extracted placement
array, never the wikitext. That constraint is now written into Step 7 above. Doing this keeps
the exposure to the attribution line plus a ToS carve-out, both cheap.

Not legal advice — but the technical decision it drives is unambiguous, so the build shouldn't
wait on a lawyer.

### 7.3 Open — two things to close out

1. **Re-probe OpenDota and promote `dota2` to `online`.** The API was returning 522 for the
   entire build. The exact fields to confirm are listed at the `dota2` entry in
   `capabilities.ts`; if they hold, it is a one-word status change with no code edit.
2. **Run the migration.** `npm run db:push` applies
   `20250101000010_esports.sql` — seed only, no DDL. Until it runs, `dota2` is absent from
   existing keys' `sport_mask` and the gateway will 403 it.

### 7.4 Open — is 6h the right confirmation window?

Kept from the artifact. `radiant_win` comes from Valve at match end and effectively never
changes; 6h is conservative but costs nothing because caching makes the re-read free. Named
constant, trivially tunable.

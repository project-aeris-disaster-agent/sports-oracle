# BUILD PLAN — Multi-Vertical Data Sources

Integrating every resource listed in `DATA_SOURCES.md` into the existing Oracle stack.

**Constraint:** additive only. No renames, no route restructure, no behaviour change to any
existing endpoint. Every phase below can ship on its own and be reverted on its own.

---

## 0. Summary of the deviation from the artifact

The artifact's *provider abstraction* is correct and worth adopting verbatim. Its
*integration mechanics* would break the current build in three places. This plan keeps the
first and replaces the second.

| Artifact proposes | Why it breaks us | This plan does instead |
|---|---|---|
| `/api/v1/[vertical]/[subject]/[dataType]/route.ts` | Next.js App Router forbids two different slug names at the same path position. `[vertical]` alongside the existing `[sport]` is a **hard build error** ("You cannot use different slug names for the same dynamic path"). | Reuse the existing slug: `src/app/api/v1/[sport]/[dataType]/route.ts`. Static children (`schedule/`, `scores/`, …) take precedence over the dynamic child, so all 11 existing routes are untouched. URLs become `/api/v1/f1/laps`, `/api/v1/defi/protocols`. |
| `rename column sports_cache.sport to subject` | Breaks `upsert_cache()`, `get_cached()`, the `cache_health` view, 4 indexes, `serve.ts`, `status.ts`. | Leave the column. New subjects reuse the existing 3-part cache-key shape `{subject}:{dataType}:{qualifier}`. **Zero SQL function changes.** |
| `rename api_keys.sport_mask to access_mask` | `verify_api_key()` returns `sport_mask`; `gateway.ts` destructures it; `usage_summary` view selects it; `staker_sessions` mirrors it; the key-create route writes it. Five-way simultaneous break. | Leave the column. Free sources are gated on **rate limit only** (which is what the artifact's own tier table says should happen) via an optional `requireMask: false` flag on `gateway()`. |
| `rename sport_config to source_config` + seed rows | `sport_config` is currently read by nothing — the warm job takes its input from the workflow YAML. Renaming it buys nothing and risks the `db:push` diff. | Don't touch it. New-provider TTLs live in the TypeScript registry, exactly as `capabilities.ts` already does for sports. **Zero config migration.** |

Net database work for the whole project: **one migration, one statement.**

---

## 1. Architecture

```
src/lib/providers/
├── types.ts        Provider interface (from the artifact, unchanged)
├── _http.ts        Shared keyless JSON fetch + timeout
├── registry.ts     SOURCES catalog · subject→provider routing · dispatcher
├── defillama.ts
├── openf1.ts
├── jolpica.ts
├── polymarket.ts
├── kalshi.ts
├── manifold.ts
├── nws.ts
├── congress.ts
├── fec.ts
└── openligadb.ts

src/app/api/v1/[sport]/[dataType]/route.ts   ← one generic handler, all new subjects
```

### Request path

```
GET /api/v1/f1/laps?session_key=9161
  → [sport]/[dataType]/route.ts
  → registry.lookup('f1', 'laps')          → { provider: openf1, ttl: 3600, metered: false }
  → serveCached({ ..., unmetered: true, fetcher })
      → gateway(req, 'f1', { requireMask: false })   auth + rate limit, no mask check
      → sandbox branch SKIPPED (unmetered → Scout gets real data)
      → get_cached('f1:laps:session_9161')           existing RPC, unchanged
      → miss → openf1.fetch() → upsert_cache(source: 'openf1')   existing RPC, unchanged
```

Sportradar keeps its own path (`fetchAndCache` → `check_budget` → `increment_budget`)
completely unchanged. The `metered` flag is what separates them, and only `sportradar`
carries it.

### Subject namespace

New subjects are checked against the existing 9 sport keys — no collisions.

| Subject | Vertical | Provider(s) | Auth |
|---|---|---|---|
| `f1` | sports | openf1 (2023+, telemetry), jolpica (history, standings) | none |
| `bundesliga` | sports | openligadb | none |
| `weather` | weather | nws | User-Agent header |
| `defi` | crypto | defillama | none |
| `polymarket` | prediction | polymarket (gamma/clob/data) | none |
| `kalshi` | prediction | kalshi (read side only) | none |
| `manifold` | prediction | manifold | none |
| `congress` | political | congress.gov | `DATA_GOV_API_KEY` |
| `fec` | political | fec | `DATA_GOV_API_KEY` (same key) |

Vertical is metadata on the registry entry only — it drives the docs/landing page and
nothing on the hot path. That is deliberate: no vertical column, no vertical route segment.

---

## 2. Phases

Each phase ends green: `npx tsc --noEmit && npm run build`.

### Phase 1 — Foundation (no user-visible change)

**New:** `types.ts`, `_http.ts`, `registry.ts` (catalog + dispatcher, no providers registered yet).

`_http.ts` is the artifact's helper plus two additions the artifact omits:
- request coalescing, copied from the `inFlight` map in `sportradar.ts:300` — the same
  cold-key stampede applies to free sources, and DefiLlama/Polymarket will rate-limit us
  for it even though there's no quota cost.
- a `headers` passthrough, needed by NWS.

`registry.ts` exports:
```ts
lookup(subject, dataType): SourceEntry | null     // null → 404
isOpenSubject(subject): boolean                   // → skip mask check
SOURCES: SourceEntry[]                            // catalog for docs/manifest
```

**Modified — `src/middleware/gateway.ts`** (~4 lines):
```ts
export async function gateway(
  req: NextRequest,
  sport: string,
  opts: { requireMask?: boolean } = {}          // NEW, defaults to current behaviour
)
...
if (opts.requireMask !== false && !sport_mask.includes(sport)) { ... }
```
Optional param with a default → all 12 existing call sites compile and behave identically.

**Modified — `src/lib/serve.ts`** (~10 lines): two optional `ServeOptions` fields.
```ts
/** Unmetered source: skip the sandbox branch and the sport-mask check. */
unmetered?: boolean
/** Replaces the Sportradar fetch. Provided by the generic route. */
fetcher?: (cacheKey: string, ttl: number) => Promise<{ data: unknown; fetchMs: number }>
```
- `gateway(req, sport, { requireMask: !opts.unmetered })`
- sandbox branch guarded by `if (context.sandbox && !unmetered)`
- step 4 calls `opts.fetcher ?? fetchAndCache(...)`

Everything else in `serve.ts` — edge headers, `Vary`, `?fields`, `?limit`, shaping, logging,
the 503-on-quota mapping — is reused as-is. That is the whole point of doing it here.

> **Why Scout gets real data on free sources:** it costs us nothing upstream, and it is the
> artifact's stated selling point — Scout becomes worth staking for. The sandbox exists to
> protect the *licensed* Sportradar feed, and that protection is unchanged.

### Phase 2 — Thin vertical slice: DefiLlama + generic route

Ship the simplest provider and the route together so the whole path is proven end-to-end
before nine more providers depend on it.

**New:** `defillama.ts` (~35 lines, no params, no key), `[sport]/[dataType]/route.ts` (~40 lines).

The route: resolve → 404 on unknown → delegate to `serveCached`. No provider-specific logic
in it, ever.

| dataType | Path | TTL |
|---|---|---|
| `protocols` | `/protocols` | 900 |
| `protocol` | `/protocol/{slug}` | 900 |
| `chains` | `/v2/chains` | 900 |
| `chart` | `/charts/{chain}` | 3600 |
| `fees` | `/summary/fees/{protocol}` | 3600 |
| `dexs` | `/overview/dexs` | 900 |
| `stablecoins` | `stablecoins.llama.fi/stablecoins` | 900 |
| `yields` | `yields.llama.fi/pools` | 900 |
| `prices` | `coins.llama.fi/prices/current/{chain}:{address}` | 300 |

**Gate:** `/api/v1/defi/protocols` returns live TVL on a Scout key, cache HIT on the second
call, and all 11 existing endpoints still pass. Nothing proceeds until this is true.

### Phase 3 — F1 (openf1 + jolpica)

Two providers, one subject. The registry routes per dataType, which is exactly the case the
`lookup(subject, dataType)` signature exists for.

**openf1** — `sessions` 604800, `meetings` 604800, `drivers` 604800, `laps` 3600,
`position` 30, `intervals` 30, `pit` 300, `stints` 300, `weather` 300, `race_control` 30.

**`car_data` is registered but flagged `noStore: true`** — proxied through, never written to
`sports_cache`. A single session is tens of MB against a 500MB Supabase cap. This needs one
extra branch in the dispatcher; it is the only special case in the whole build besides NWS.

**jolpica** — `results`, `standings` (driverStandings), `constructor_standings`,
`qualifying`, `race_laps`, `circuits`, all 86400; `all_drivers` 604800.

Adds a complete new sport at zero Sportradar cost. Do not add F1 to `capabilities.ts::SPORTS`
— `status.ts` joins that array against `budget_status`, which has no F1 row, and it would
render a broken status tile. F1 surfaces through `SOURCES` instead.

### Phase 4 — Prediction markets (polymarket, kalshi, manifold)

Highest value for the existing user base, and all three are keyless with near-identical shapes.

**polymarket** — three hosts behind one provider (the confusing part the artifact calls out):
`events` 300 and `markets` 300 → gamma · `prices_history` 900 and `book` 30 → clob ·
`trades` 60 → data.

**kalshi** — read side only. `markets`, `market`, `events`, `series` 300; `orderbook` 30.
No RSA-PSS signing: we serve data, we don't trade. Effectively Tier S.

**manifold** — `markets`, `market`, `search`, `bets`, all 300.

### Phase 5 — NWS (weather)

The only provider needing real care.

- `User-Agent` header is **mandatory** — requests without it are rejected. New env var
  `NWS_USER_AGENT` (format: `(newprontera.com, sedano@newprontera.com)`).
- Two-step grid resolution: `/points/{lat},{lon}` → forecast URL → forecast. Step 1 cached
  **30 days** under its own cache key, which halves outbound request count.
- Coordinates capped at 4 decimals — round before building the URL, or NWS errors.
- 404 from `/points` = outside US coverage. Map to a clear 404, not a 502; the artifact
  correctly notes this is the most common error.
- Never hardcode gridpoint paths — always read them from the `/points` response.

dataTypes: `points` 2592000, `forecast` 3600, `forecast_hourly` 3600, `alerts` 300,
`observations` 900.

Open-Meteo is **deferred to v2** — free tier is non-commercial only. NWS covers US; the
self-hosted Open-Meteo route for global coverage is a separate piece of infrastructure work,
not a provider file.

### Phase 6 — Political (congress + fec)

One free `api.data.gov` key serves both. New env var `DATA_GOV_API_KEY`.

**Missing-key behaviour:** these two providers are registered unconditionally but return a
clean `503 "provider not configured"` when the env var is absent. A missing key must never
fail the build or break an unrelated deploy.

**congress** — `bills` 3600, `bill` 3600, `bill_actions` 1800, `members` 86400,
`member` 86400, `committees` 604800, `amendments` 3600, `summaries` 3600.
Always send `limit=250` on list calls; the default of 20 burns the 5,000/hr quota fast.

**fec** — `candidates` 86400, `candidate_totals` 21600, `committees` 86400, `filings` 900.

> **`schedules/schedule_a` and `schedule_b` are deliberately NOT registered.** FEC itemized
> contributor data carries a statutory restriction against commercial use — federal law, not
> a ToS. The simplest possible compliance is to not have an endpoint for it. Committee and
> candidate totals are fine and are what we expose.

### Phase 7 — OpenLigaDB (optional)

`season` (getmatchdata/{league}/{season}), `matchday` (getmatchdata/{league}) 300,
`table` (getbltable) 3600, `leagues` (getavailableleagues) 604800.

German football only. Marketplace breadth, not a soccer solution — ship it or drop it on its
own merits; nothing else depends on it.

### Phase 8 — Surface area

1. **Migration `007_widen_cache_subjects.sql`** — the only SQL in the project:
   ```sql
   alter table sports_cache drop constraint if exists sports_cache_sport_check;
   ```
   The registry already validates `(subject, dataType)` before anything reaches
   `upsert_cache`, so the CHECK is now redundant duplication of the source of truth.
   *(Conservative alternative if you'd rather keep the net: re-add the constraint with the
   9 existing keys plus the 9 new subjects. One extra line, one extra edit per future
   source.)*

2. **`[sport]/route.ts` manifest** (~10 lines) — when `getSport()` misses, fall back to
   `SOURCES` and emit the same endpoint-manifest shape. `/api/v1/f1` then self-describes
   like `/api/v1/nba` does.

3. **MCP tools** (`src/app/api/mcp/route.ts`, additive) — `get_prediction_markets`,
   `get_f1`, `get_weather`, `get_defi`, `get_congress`. Existing 11 tools untouched.
   One-line change: the mask check at line 333 gains the `isOpenSubject()` bypass.

4. **`.env.example`** — `DATA_GOV_API_KEY`, `NWS_USER_AGENT`, both documented as optional.

5. **Cache warm-up** — a new `warm-open-sources` job in `cache-warmup.yml`. Do **not**
   extend the existing sport matrix; a failure in a free source must not fail the
   Sportradar warm job. Modest cadence: F1 standings + DefiLlama chains + Congress members
   daily. Free ≠ unlimited — NWS is ~5,000/hr with a 1s-spacing convention.

6. **Landing page** — a second "Open Data" section below the existing sports grid, driven by
   `SOURCES`. `capabilities.ts` and `status.ts` are not touched.

---

## 3. Explicitly out of scope

| Excluded | Reason |
|---|---|
| balldontlie, TheSportsDB, CoinGecko | Tier B — free tier is non-commercial or has reselling clauses. Ours is a paid product. |
| NHL Web API, MLB Stats API, ESPN hidden APIs | Undocumented/unofficial, no commercial redistribution terms. Fine internally, not behind the paywall. |
| US equities (all providers) | Exchange licensing. The artifact's position is right — revisit with revenue. |
| Open-Meteo | Free tier non-commercial. v2, self-hosted. |
| FEC itemized donor records | Statutory restriction. |
| OpenF1 team radio | F1 stopped releasing it for most 2026 sessions. Don't build on it. |
| Polymarket/Kalshi trading endpoints | We serve data. Skipping them also skips RSA-PSS signing entirely. |

---

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Dynamic child route shadows an existing static route | Next.js resolves static before dynamic. Verified by the Phase 2 gate: all 11 existing endpoints must still pass before Phase 3 starts. |
| Free source goes down and takes a route with it | Each provider is isolated behind `_http.ts`'s 7s timeout; a failure returns 502 for that subject only. No shared state with Sportradar. |
| Telemetry blows the 500MB Supabase cap | `car_data` registered `noStore` — proxied, never cached. |
| Outbound rate limits on free sources | Cache-first path already absorbs this. Warm crons kept conservative. NWS respects the 1s-spacing convention. |
| Missing `DATA_GOV_API_KEY` in an environment | Providers return 503 "not configured". Never a build or deploy failure. |
| Scout keys now reach real upstreams | Only unmetered ones, which cost nothing. Rate limit (30 rpm) still applies. Sportradar sandbox behaviour is byte-for-byte unchanged. |

---

## 5. Effort

| Phase | Files | Rough size |
|---|---|---|
| 1 Foundation | 3 new, 2 modified | ~180 lines |
| 2 DefiLlama + route | 2 new | ~75 lines |
| 3 F1 | 2 new | ~80 lines |
| 4 Prediction markets | 3 new | ~110 lines |
| 5 NWS | 1 new | ~70 lines |
| 6 Political | 2 new | ~80 lines |
| 7 OpenLigaDB | 1 new | ~35 lines |
| 8 Surface area | 1 migration, 5 modified | ~120 lines |

**Total: ~14 new files, 7 small additive edits, 1 one-line migration.**

Phases 3–7 are mutually independent — any of them can be reordered, deferred, or dropped
without affecting the others.

---

## 6. Verification per phase

```bash
npx tsc --noEmit && npm run build
```

Plus the regression smoke set — these must return identical results at every phase:

```bash
curl -H "X-Oracle-Key: $KEY" "$APP_URL/api/v1/nba/injuries"
curl -H "X-Oracle-Key: $KEY" "$APP_URL/api/v1/nfl/depth-chart?week=1"
curl -H "X-Oracle-Key: $KEY" "$APP_URL/api/v1/tennis/standings"
curl -H "X-Oracle-Key: $KEY" "$APP_URL/api/v1/nba"
curl -H "X-Oracle-Key: $SCOUT_KEY" "$APP_URL/api/v1/nba/scores"   # must still be SANDBOX
```

The last one is the one that matters most: it proves the licensed feed is still gated.

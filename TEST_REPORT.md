# Sports Oracle — Test Report

**Date:** 2026-07-24
**Build:** local dev (`next dev`), live Supabase + Upstash + Sportradar production keys
**Result:** **82 pass / 0 fail** after remediation — 3 defects found, all fixed and re-verified

---

## 1. Executive summary

All 7 entitled sports and 51 endpoint combinations were exercised against live upstream data,
including a full agent lifecycle simulation (pre-match → live → post-match) and deliberate
breaking-point testing.

Three defects were found. **One was severe and would have caused user-visible failures in
production.** All three are fixed and re-verified.

| # | Defect | Severity | Status |
|---|---|---|---|
| 1 | Spurious `401 Invalid or revoked API key` under concurrency | **Critical** | Fixed |
| 2 | No cache-stampede protection — 17x duplicate upstream calls | **High** | Fixed |
| 3 | Rate limiting unverifiable (masked by #1) | Medium | Fixed + verified |

Two sports (NASCAR, NBA G League) remain unreachable — a Sportradar account
provisioning issue, not a code defect.

---

## 2. Scope and method

**Phase 1 — Per-sport sweep.** Every endpoint of every entitled sport, with real IDs
extracted from live hierarchy/schedule responses (not synthetic fixtures).

**Phase 2 — Agent lifecycle.** A simulated agent working an MLB game:
pre-match research (T-24h) → live polling (10 polls @ 5s against a 30s TTL) →
post-match settlement (T+1h).

**Phase 3 — Breaking points.** Rate limits, cache stampede, malformed and hostile input,
budget isolation, and 60-way concurrency.

Correctness was measured against **observed upstream behaviour**, not vendor documentation.
Several documented paths turned out to be wrong; see §7.

---

## 3. Per-sport results

All 51 combinations returned `200`. Sizes are gzipped (what actually counts against egress).

| Sport | Endpoints | Result | Notes |
|---|---|---|---|
| NBA | 9 | 9/9 | `leaders` is the largest payload in the system at 443 KB |
| NHL | 9 | 9/9 | `pbp` 114 KB |
| NFL | 8 | 8/8 | `injuries` + `depth-chart` are week-scoped |
| MLB | 8 | 8/8 | In season — only sport with live game data during the run |
| WNBA | 8 | 8/8 | In season |
| Tennis | 4 | 4/4 | No roster/teams — individual sport |
| MMA | 3 | 3/3 | v2 API; v7 returns 403 |

**Off-season behaviour is correct, not broken.** NBA/NHL/WNBA `scores` return `0.2 KB` and
`live` returns `X-Cache: SKIP` with `cost: 0 credits` — the window guard suppressing a call
that could not have returned data. This is the intended optimisation working.

---

## 4. Agent lifecycle simulation

**Pre-match (6 calls):** all served from cache, 0.8–4.1s, zero upstream credits.
Discovery (`GET /api/v1/mlb`) cost nothing — it is pure manifest data.

**Live polling — the critical result:**

```
10 polls over 50 seconds, 30s TTL
→ 3 upstream calls, 7 cache hits
```

Polling collapsed 10 agent requests into 3 upstream calls. With N agents polling the same
game, upstream cost stays flat at ~2 calls/minute regardless of N.

**Post-match:** settlement data (final scores, standings, pbp) all served from warm cache.

---

## 5. Breaking points

### 5.1 Spurious 401s under concurrency — CRITICAL

**Symptom:** 60 concurrent requests with a valid key returned **39 × `401 Invalid or revoked
API key`**. A second run showed 9/50.

**Cause:** [`gateway.ts`](src/middleware/gateway.ts) treated a Supabase RPC *failure* as
key-not-found:

```ts
if (keyError || !keyData || keyData.length === 0) return errorResponse(401, ...)
```

Under burst, the free-tier connection pool saturates, `verify_api_key` errors, and the caller
is told their key is revoked. A developer hitting this would rotate a perfectly good key and
still fail.

**Fix:** three changes.
1. Infrastructure failure now returns **`503` + `Retry-After`**, explicitly stating the key is
   unaffected. Only a genuine not-found returns 401.
2. One retry on transient error.
3. A 30-second per-instance verified-key cache, which removes most verification RPCs from
   the hot path. `last_used_at` writes moved into the cache-miss path — they were adding a
   database write per request and were a major contributor to pool pressure.

**Verified:** 60/60 × `200`, zero spurious 401s.

### 5.2 Cache stampede — HIGH

**Symptom:** 25 concurrent requests against a cold key produced **17 duplicate upstream
calls** for one document — 17x quota cost, and a burst that can trip Sportradar's 25 QPS
ceiling.

**Fix:** in-flight request coalescing in `fetchAndCache`. Concurrent callers for the same
cache key await one shared promise.

**Verified:** 25 concurrent cold requests → **1 upstream call**.

### 5.3 Rate limiting

Initially appeared broken (45 sequential requests, zero 429s). Two causes:
- Most requests were failing with defect 5.1 before reaching the limiter.
- 45 sequential requests spread over ~90s never exceed 30-in-any-60s-window. A sliding
  window **correctly** allows this; the test was wrong, not the code.

**Verified with 60 concurrent:** exactly **30 × `200`, 30 × `429`**, zero 401s.

### 5.4 Input validation — 10/10 pass

`limit=0`, `limit=-5`, `limit=999999999`, `limit=abc`, `fields=__proto__`, a 200-element
`fields` list, SQL-ish `team_id`, unknown sport, unknown endpoint, malformed date — all
handled without 500s or prototype pollution.

### 5.5 Budget isolation — pass

All 9 sports track independently with correct per-sport limits.

---

## 6. Capacity

Measured, gzipped. Average full response **116.6 KB**; with `?limit=N` **18.1 KB**.

| Constraint | Free-tier limit | Ceiling (total req/mo) |
|---|---|---|
| Supabase egress, full payloads | 5 GB | 180,000 |
| **Supabase egress, shaped** | 5 GB | **1,156,000** |
| **Upstash** | 10k cmd/day | **1,200,000** |
| Sportradar | 1,027,500 usable | not binding |

Supabase and Upstash now land within 4% of each other — the system is balanced, and no
single remaining lever moves the ceiling much on its own.

| Agent profile | Capacity |
|---|---|
| Light (100 req/mo) | ~11,500 agents |
| Moderate (300 req/mo) | ~3,850 agents |
| Heavy (1,000 req/mo) | ~1,150 agents |

Current consumption after all testing: **68 upstream calls** against 1,027,500 available.

---

## 7. Upstream findings

Corrected during this work — all were wrong in the original `sportradar.ts`:

- **`scores` was broken for every sport.** Built `/games/2026-07-24/boxscores.json`;
  Sportradar requires separate segments `/games/2026/07/24/`.
- **NFL standings** path wrong (`/REG/standings.json` → `/REG/standings/season.json`).
- **MMA** v7 returns 403; v2 works.
- **Tennis** schedule is `/schedules/{date}/summaries.json`, not tournament-scoped.
- **NBA/NHL/WNBA have no daily boxscore endpoint** — daily *schedule* carries the scores.
  Only MLB has a true daily boxscore.

**Odds Comparison remains unavailable.** All six products (prematch, player props, futures,
regular, USP, USSP) return 403. No betting lines, spreads, or moneylines are obtainable.

---

## 7a. Security review — staking and API keys

Added after the tier system (Scout free / Analyst 1M / Oracle 20M) went in.
An adversarial suite of 18 attacks was run against the live stack. **All 18 are
blocked**, after four defects were found and fixed.

### Defects found and fixed

| # | Defect | Severity | Impact if shipped |
|---|---|---|---|
| 1 | `verify-stake` trusted the wallet address in the request body | **Critical** | Anyone could submit a whale's address and be granted that whale's tier. Free Oracle access for all. |
| 2 | Rate limits bucketed on `key_id` | **High** | Mint N keys, get N× your tier's rate. Trivially unlimited throughput. |
| 3 | Keys survived an unstake | **High** | Stake → mint key → unstake in the same minute → permanent paid access. Nothing re-checked. |
| 4 | Placeholder env defeated fallbacks | **High** | `??`/`\|\|` treat `"0x...your-contract-address"` as a real value. Every chain read threw, so the stake watcher **skipped every wallet and revoked nobody** — a security control failing open. |

**Fixes.**
1. Wallet ownership is verified against the Privy account's linked accounts, and
   fails **closed** — if ownership can't be established, no tier is granted.
2. `verify_api_key` now returns `privy_id`; the limiter buckets per account.
   Verified: 100 requests across 5 keys yielded exactly 30 successes at a 30/min cap.
3. `verify_api_key` reports whether the key's wallet still holds an active
   commitment; the gateway rejects with `403` when it does not. A stake watcher
   (`POST /api/internal/refresh-stakes`, every 10 min) re-reads balances on-chain
   and revokes breaches, so an unstake is caught even if the user never returns.
4. Env values matching a placeholder pattern are treated as absent. Verified: the
   watcher now revokes a zero-balance wallet (`staked 0 < required 1,000,000`)
   while still *skipping* unreadable addresses rather than revoking them.

### Attacks confirmed blocked

- **Tier escalation** — sandbox keys cannot reach live data, including when the
  `tier` column is tampered directly to `oracle` (`is_sandbox` is authoritative).
- **Rate-limit bypass** — 5 keys, one account, one shared limit.
- **Access after unstake** — `403` once the commitment ends; watcher catches
  silent withdrawals.
- **Sport-mask escalation** — `403` outside the mask.
- **Key forgery** — random, prefix-only, SQL-injection, 5KB, duplicate-header and
  control-character keys all rejected. Malformed headers are refused with `400`
  by the HTTP parser before reaching auth code (verified over a raw socket).
- **Revoked/inactive keys** — `401`.

### Residual risk

- **Revocation lag ≤ 30s.** The per-instance key cache means a revoked key can
  survive up to 30 seconds on an already-warm instance. Deliberate trade-off:
  removing the cache reintroduces the connection-pool exhaustion that caused
  spurious 401s (§5.1). Shorten `KEY_TTL_MS` if a tighter bound is needed.
- **Watcher cadence.** A 10-minute cron means a withdrawal is caught within
  10 minutes, not instantly. Closing that fully requires either an on-chain lock
  (contract redeploy) or per-request chain reads (far too slow).
- **The contract has no lock-up.** `withdraw()` is callable at any time, so the
  7-day and 30-day commitments are enforced by revocation, not by the chain.

## 8. Recommendations

**P1 — before production**

1. **Run `cleanup_expired_cache()` daily.** Play-by-play is ~1.7 MB raw per game; the
   500 MB database fills at roughly 290 cached PBP entries. This job is now load-bearing.
2. **Alert on `503` rate from the gateway.** It now correctly signals infrastructure
   distress rather than hiding as 401. It is a real signal — monitor it.
3. **Re-verify NHL/NFL/WNBA `pbp` in season.** They use a confirmed API version and path
   pattern, but could not be exercised with a truly in-progress game in July.

**P2 — capacity**

4. **Push `?limit=` in agent-facing docs and MCP descriptions.** The 6.4x capacity gain is
   opt-in; an agent ignoring it still costs 116 KB. Consider a default cap on `leaders`
   and `pbp` specifically — they dominate egress.
5. **Watch the Upstash *daily* cap.** 10k/day is now co-binding. A burst can exhaust it
   while monthly usage looks healthy.
6. **Consider raising the key cache TTL above 30s** if revocation latency is acceptable.
   It directly reduces the RPC load that caused defect 5.1.

**P3 — coverage**

7. **Chase NASCAR + G League activation.** 77,500 calls/month provisioned but 403 on every
   path variant tested. Dashboard shows quota; the API disagrees.
8. **Soccer is reachable** (`/soccer/trial/v4/`) but is a Trial at 359% of a 1,000 quota —
   not safe to build on without an upgrade.

**P4 — known limitations**

9. Coalescing and the key cache are **per-instance**. On Vercel, N warm lambdas mean up to
   N upstream calls on a cold key, not 1. Still a ~25x improvement, but not a global lock.
   A cross-instance lock would need Redis — which costs the scarce Upstash budget.
10. Dev-server latency (p50 13s at 60-way concurrency) is **not** representative of
    production; Vercel scales horizontally per request.

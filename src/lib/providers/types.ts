// src/lib/providers/types.ts
// The contract every upstream data source implements.
//
// This is the seam that makes the build a data router rather than a Sportradar
// wrapper. A provider declares where its data lives, how to authenticate, what it
// costs us, and — critically — whether its output is good enough to settle a
// market on. Everything else in the pipeline (cache, gateway, shaping, logging)
// is already provider-agnostic and stays untouched.

export type ProviderId =
  | 'sportradar'
  | 'jolpica'
  | 'openf1'
  | 'openligadb'
  | 'sackmann'
  | 'mlbstats'
  | 'nhlweb'
  | 'txline'
  | 'opendota'
  | 'liquipedia'
  | 'riot'
  | 'agentfighter'

/**
 * Commercial-redistribution posture. This is enforced, not decorative:
 * serveCached refuses to put an `unclear` source behind a paid tier.
 *
 *   licensed — we hold a commercial agreement (Sportradar)
 *   open     — published as an open community resource, reuse is unambiguous
 *   unclear  — free and public, but no published terms permitting resale
 */
export type License = 'licensed' | 'open' | 'unclear'

/**
 * Whether a registered provider is actually serving traffic.
 *
 *   live    — wired up and answering requests
 *   offline — registered, documented and discoverable, but not serving
 *
 * Offline is a first-class state, not a placeholder. A router's value is partly
 * in publishing what it *could* route to, so an integrator can see a source
 * exists and what its terms are before it is switched on. Selecting one returns
 * an explicit 503 rather than pretending it isn't there.
 */
export type ProviderStatus = 'live' | 'offline'

export interface ProviderAuth {
  query?:   Record<string, string>
  headers?: Record<string, string>
}

export interface Provider {
  id:    ProviderId
  /** Shown in the sport card and stamped into every response envelope. */
  label: string
  /** Public homepage, so a consumer can verify provenance themselves. */
  homepage: string
  /** Credit line. Open providers are reused on the strength of goodwill — name them. */
  attribution: string

  base: string
  /** Endpoint-key -> path template. Templates may carry their own query string. */
  endpoints: Record<string, string>

  /**
   * How a (sport, dataType) pair maps to a key in `endpoints`.
   *
   * Single-sport providers (OpenF1, Jolpica) key on dataType alone. Sportradar
   * serves nine sports from one map and namespaces as `{sport}:{dataType}`.
   * Defaults to dataType.
   */
  endpointKey?: (sport: string, dataType: string) => string

  /**
   * Whether calls draw down a paid quota. False skips the budget RPCs entirely —
   * a free provider should not cost two Supabase round-trips to prove it's free.
   */
  metered: boolean

  license: License

  status: ProviderStatus

  /** Why a provider is offline. Surfaced verbatim to callers, so be specific. */
  offlineReason?: string

  /**
   * Per-account requests/minute this upstream should be held to, out of courtesy
   * rather than cost.
   *
   * Distinct from `metered`. A free provider costs us nothing, which is exactly
   * why nothing else would throttle it — but the open F1 sources are volunteer-run
   * infrastructure with no commercial relationship to lean on, and pointing a
   * paid product's traffic at them unthrottled is how open resources get closed.
   * Omitted for providers we pay, where the quota is already the limit.
   */
  politeRpm?: number

  /**
   * May this source mark a result `official`?
   *
   * A fast provider that reports the finishing order seconds after the flag is
   * not the same as the governing body's classification after scrutineering and
   * stewards' decisions. Only an authoritative source may settle a market; every
   * other source is capped at `provisional` no matter how confident it looks.
   */
  authoritative: boolean

  /**
   * Credentials for a request. May be async: some upstreams issue short-lived
   * session tokens that have to be minted and refreshed at runtime rather than
   * read from the environment. Implementations are expected to cache — this is
   * called on every request.
   */
  auth?: () => ProviderAuth | Promise<ProviderAuth>

  /**
   * Narrows an upstream payload before it is cached.
   *
   * Applied in `fetchUpstream` immediately after parsing, so the projected shape
   * is what lands in `sports_cache` AND what every consumer sees — there is no
   * path that observes the raw document. Two distinct reasons a provider needs
   * this, both of which are about what we are allowed or able to *store*:
   *
   *   Size. OpenDota's /matches/{id} carries full per-player telemetry — hundreds
   *   of KB for a resolution that is one boolean. Caching that verbatim per match
   *   would exhaust the Supabase 500MB tier on data no endpoint reads.
   *
   *   Licence. A source may permit reuse of the facts while its raw text stays
   *   copyrighted. Projecting at fetch time means the restricted form is never
   *   written to our database at all, rather than being written and then withheld.
   *
   * Pure and synchronous — it must not fetch, and must tolerate any shape the
   * upstream returns, including an error envelope.
   */
  project?: (data: unknown, dataType: string) => unknown
}

/** Thrown for every upstream failure, regardless of provider. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public status?:   number,
    public sport?:    string,
    public dataType?: string,
    public provider?: ProviderId
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/**
 * Builds a request URL from a template.
 *
 * Uses URL/searchParams rather than string concatenation because open providers
 * put query parameters directly in their endpoint templates (OpenF1 keys almost
 * everything off `session_key`), and the old `?api_key=` concatenation produced a
 * malformed URL the moment a template already contained a `?`.
 */
export function buildUrl(
  provider: Provider,
  dataType: string,
  params: Record<string, string> = {},
  sport = '',
  auth?: ProviderAuth
): string {
  const key      = provider.endpointKey?.(sport, dataType) ?? dataType
  const template = provider.endpoints[key]
  if (!template) {
    throw new UpstreamError(
      `${provider.label} has no endpoint for ${sport || '?'}/${dataType}`,
      404, sport, dataType, provider.id
    )
  }

  const path = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined || value === '') {
      throw new UpstreamError(
        `Missing required param "${key}" for ${sport ?? '?'}/${dataType}`,
        400, sport, dataType, provider.id
      )
    }
    return encodeURIComponent(value)
  })

  const url = new URL(provider.base + path)


  // Auth is resolved by the caller and passed in, because it may be async.
  if (auth?.query) {
    for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v)
  }

  return url.toString()
}

/**
 * Which template placeholders `params` cannot fill. Empty means buildUrl will
 * succeed.
 *
 * buildUrl throws on a missing placeholder, which is right for a real request —
 * the caller asked for something unanswerable. But a blind pre-fetch is not a
 * caller: the warm job walks every endpoint a sport declares, and some of those
 * are addressed by an id or a week that no scheduled job can know. Those should
 * report an honest skip, not an upstream error.
 *
 * The cache qualifier and the URL template do not always agree on this — NFL
 * injuries default to week 1 in the qualifier but leave `{week}` unfilled in the
 * path — so asking the template directly is the only reliable answer.
 */
export function missingParams(
  provider: Provider,
  dataType: string,
  params:   Record<string, string>,
  sport = ''
): string[] {
  const key      = provider.endpointKey?.(sport, dataType) ?? dataType
  const template = provider.endpoints[key]
  if (!template) return []
  return [...template.matchAll(/\{(\w+)\}/g)]
    .map(m => m[1])
    .filter(p => !params[p])
}

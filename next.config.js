/** @type {import('next').NextConfig} */
const nextConfig = {
  // @privy-io/server-auth is bundled into each route that imports it, like every
  // other dependency. It was previously listed in serverComponentsExternalPackages,
  // which leaves it OUT of the bundle and relies on Vercel's file-tracing to copy
  // the package (and its heavy transitive deps: @solana/web3.js, @hpke/core,
  // @noble/*) into the serverless function. When tracing misses any of them the
  // runtime `require` throws at module load — which takes down exactly the routes
  // that import Privy (keys, keys/create, verify-stake, stake/position) with an
  // opaque HTML 500, while every non-Privy route keeps working. Bundling removes
  // that dependency on tracing entirely.

  // Security headers. The platform already sends HSTS; these are the rest of the
  // baseline. No behavioural change for the JSON API — they matter because API
  // error strings and payloads do get rendered by third-party clients, and
  // `nosniff` plus a deny-by-default CSP is what stops a JSON response being
  // coerced into an executable context.
  async headers() {
    const base = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options',        value: 'DENY' },
      { key: 'Permissions-Policy',     value: 'geolocation=(), microphone=(), camera=()' },
    ]

    // ORDER MATTERS. `/:path*` also matches `/api/...`, and for a duplicated
    // header key the LAST matching rule wins — so the API rule must come second
    // or the permissive app-shell CSP silently overrides the strict API one.
    return [
      {
        // App shell. Next.js injects inline styles/scripts, and the wallet SDKs
        // need their own origins, so this stays permissive enough to render while
        // still pinning frame-ancestors and object-src.
        source: '/:path*',
        headers: [
          ...base,
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.privy.io https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "connect-src 'self' https: wss:",
              "frame-src https://*.privy.io https://challenges.cloudflare.com",
              "object-src 'none'",
              "base-uri 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // API: never a document, so it can deny everything. Also `no-referrer`,
        // because an API key can ride in a URL a client constructed.
        source: '/api/:path*',
        headers: [
          ...base,
          { key: 'Referrer-Policy',         value: 'no-referrer' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
    ]
  },
}

module.exports = nextConfig

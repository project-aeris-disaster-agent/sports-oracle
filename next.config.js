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
}

module.exports = nextConfig

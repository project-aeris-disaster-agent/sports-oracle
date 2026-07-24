/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@privy-io/server-auth'],
  },
}

module.exports = nextConfig

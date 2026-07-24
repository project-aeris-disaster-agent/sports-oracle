'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { base }          from 'viem/chains'

/**
 * Auth shell.
 *
 * Three ways in — Google, email, or an external wallet (MetaMask et al). The
 * first two produce users with no wallet of their own, so Privy provisions an
 * embedded one for them. That matters here because a wallet is not optional:
 * staking, tier assignment and key issuance are all keyed to an address. A user
 * who signs in with Google must still end up holding something they can stake
 * from, and the embedded wallet is that.
 *
 * `noPromptOnSignature` is deliberately NOT set — signing should stay explicit.
 */
export function PrivyProviderWrapper({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  // Privy throws on an empty or placeholder app ID, which would take down every
  // page including the public ones. Render without it rather than crash.
  const configured = appId && appId.length > 0 && !appId.startsWith('your-')
  if (!configured) return <>{children}</>

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['google', 'email', 'wallet'],

        // Base only. Offering other chains would let a user connect a wallet we
        // can't read stake from, which reads as a broken product rather than an
        // unsupported network.
        defaultChain:    base,
        supportedChains: [base],

        embeddedWallets: {
          // Google/email users get a wallet automatically; wallet users keep
          // the one they arrived with.
          createOnLogin: 'users-without-wallets',
          requireUserPasswordOnCreate: false,
        },

        appearance: {
          theme: '#000000',
          accentColor: '#2f81f7',
          landingHeader: 'Sports Oracle',
          loginMessage: 'Sign in to mint an API key. Scout is free — no stake required.',
          showWalletLoginFirst: false,
          walletList: ['metamask', 'coinbase_wallet', 'rainbow', 'wallet_connect'],
        },

        legal: {
          termsAndConditionsUrl: undefined,
          privacyPolicyUrl:      undefined,
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}

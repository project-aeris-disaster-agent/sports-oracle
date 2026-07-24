'use client'

import { usePrivy } from '@privy-io/react-auth'
import { useRouter } from 'next/navigation'

/**
 * The single entry point into the product.
 *
 * Previously every call to action was a plain link to /dashboard, which redirects
 * unauthenticated visitors back to the landing page — so a new user clicking
 * "Get API key" was bounced home with no explanation and no way to sign in.
 * This opens the Privy modal when signed out and only routes through to the
 * console once there is a session.
 */
export function LoginButton({
  className = '',
  children,
  redirectTo = '/dashboard',
}: {
  className?: string
  children?: React.ReactNode
  redirectTo?: string
}) {
  const { ready, authenticated, login } = usePrivy()
  const router = useRouter()

  function handle() {
    if (!ready) return
    // Signing in happens in place — the modal opens over the main page and the
    // visitor stays there. Only an explicit click goes through to the console,
    // so authenticating never yanks someone out of the page they were reading.
    if (authenticated) router.push(redirectTo)
    else login()
  }

  return (
    <button
      onClick={handle}
      disabled={!ready}
      className={`${className} ${!ready ? 'opacity-60 cursor-wait' : ''}`}
    >
      {children ?? (authenticated ? 'Open console' : 'Get API key')}
    </button>
  )
}

/**
 * Header control. Shows the console link and sign-out once there is a session,
 * so the main page stays the main page rather than becoming a dead end after login.
 */
export function AccountNav({ className = '' }: { className?: string }) {
  const { ready, authenticated, login, logout } = usePrivy()
  const router = useRouter()

  if (!ready) {
    return <span className={`${className} opacity-50 text-[12px]`}>…</span>
  }

  if (!authenticated) {
    return (
      <button onClick={login} className="btn-primary rounded-md px-3.5 py-1.5 text-[12px]">
        Get API key
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => router.push('/dashboard')}
        className="btn-primary rounded-md px-3.5 py-1.5 text-[12px]"
      >
        Console
      </button>
      <button
        onClick={() => logout()}
        className="btn-ghost rounded-md px-3 py-1.5 text-[12px]"
      >
        Sign out
      </button>
    </div>
  )
}

import type { Metadata } from 'next'
import { PrivyProviderWrapper } from '@/components/privy-provider'
import './globals.css'

export const metadata: Metadata = {
  title:       'Sports Oracle',
  description: 'Sports data API for AI agents',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 font-mono">
        <PrivyProviderWrapper>
          {children}
        </PrivyProviderWrapper>
      </body>
    </html>
  )
}

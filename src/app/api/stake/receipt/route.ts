// src/app/api/stake/receipt/route.ts
// Transaction status for the stake panel's poller.
//
// The panel cannot advance from "approve" to "stake" until the approval is
// actually mined, so it needs a receipt. Doing that from the browser would mean
// either shipping the RPC key or polling the public Base endpoint every few
// seconds per tab; both are worse than one authenticated hop through here.
//
// Auth is required purely to keep this from becoming an open RPC proxy. No
// wallet check: a receipt is public chain data, and the hash is supplied by the
// caller's own wallet.

import { NextRequest, NextResponse } from 'next/server'
import { authenticate }              from '@/lib/privy'
import { getTxStatus }               from '@/lib/viem'

export async function GET(req: NextRequest) {
  const privyUserId = await authenticate(req)
  if (!privyUserId) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }

  const hash = req.nextUrl.searchParams.get('hash')?.trim()
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: 'A transaction hash is required' }, { status: 400 })
  }

  try {
    return NextResponse.json(await getTxStatus(hash as `0x${string}`))
  } catch (err) {
    console.error('[stake/receipt]', err)
    // Treat an RPC hiccup as "still pending" so the poller retries rather than
    // telling the user their transaction failed when it may well have landed.
    return NextResponse.json({ status: 'pending', degraded: true })
  }
}

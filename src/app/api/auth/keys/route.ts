// src/app/api/auth/keys/route.ts
// Lists the caller's API keys for the dashboard.
//
// Returns metadata only — never the key itself, which exists in plaintext exactly
// once, in the response to /keys/create. Revoked keys are included so the list
// doubles as an audit trail.

import { NextRequest, NextResponse } from 'next/server'
import { PrivyClient }               from '@privy-io/server-auth'
import { createClient }              from '@supabase/supabase-js'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization header' }, { status: 401 })
  }

  let privyUserId: string
  try {
    const claims = await privy.verifyAuthToken(token)
    privyUserId = claims.userId
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, tier, sport_mask, is_active, is_sandbox, last_used_at, created_at, revoked_at, suspended_at, suspend_reason')
    .eq('privy_id', privyUserId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[keys/list]', error.message)
    return NextResponse.json({ error: 'Could not load keys' }, { status: 500 })
  }

  return NextResponse.json({ keys: data ?? [] })
}

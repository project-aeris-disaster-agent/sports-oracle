// src/app/api/auth/keys/revoke/route.ts

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

export async function POST(req: NextRequest) {
  // 1. Verify Privy JWT
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization header' }, { status: 401 })
  }

  let privyUserId: string
  try {
    const claims = await privy.verifyAuthToken(token)
    privyUserId = claims.userId
  } catch {
    return NextResponse.json({ error: 'Invalid Privy token' }, { status: 401 })
  }

  const body = await req.json()
  const { keyId } = body

  if (!keyId) {
    return NextResponse.json({ error: 'keyId required' }, { status: 400 })
  }

  // 2. Confirm key belongs to this user
  const { data: existing } = await supabase
    .from('api_keys')
    .select('id, is_active')
    .eq('id', keyId)
    .eq('privy_id', privyUserId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Key not found or not yours' }, { status: 404 })
  }

  if (!existing.is_active) {
    return NextResponse.json({ error: 'Key already revoked' }, { status: 409 })
  }

  // 3. Soft-delete — keep row for audit trail
  const { error } = await supabase
    .from('api_keys')
    .update({
      is_active:  false,
      revoked_at: new Date().toISOString(),
    })
    .eq('id', keyId)

  if (error) {
    console.error('[keys/revoke] update error:', error.message)
    return NextResponse.json({ error: 'Failed to revoke key' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

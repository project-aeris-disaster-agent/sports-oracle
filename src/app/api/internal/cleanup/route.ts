// src/app/api/internal/cleanup/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { guardInternal }             from '@/middleware/gateway'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  if (!guardInternal(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [cacheResult, logsResult] = await Promise.allSettled([
    supabase.rpc('cleanup_expired_cache'),
    supabase.rpc('cleanup_old_usage_logs'),
  ])

  return NextResponse.json({
    cache_deleted: cacheResult.status === 'fulfilled' ? cacheResult.value.data : 0,
    logs_deleted:  logsResult.status  === 'fulfilled' ? logsResult.value.data  : 0,
    timestamp:     new Date().toISOString(),
  })
}

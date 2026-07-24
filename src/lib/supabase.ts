// src/lib/supabase.ts

import { createBrowserClient } from '@supabase/ssr'
import { createClient }        from '@supabase/supabase-js'

const url     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Safe to use in client components
export const supabaseBrowser = createBrowserClient(url, anonKey)

// Server-only — never import in client components
export const supabaseServer = createClient(
  url,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

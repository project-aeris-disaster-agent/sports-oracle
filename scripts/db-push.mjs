// Applies supabase/migrations/* to the remote database.
// Uses SUPABASE_DB_URL from .env (transaction pooler, port 6543).
//
// Why not `supabase link` + `supabase db push`?
//   `link` hardcodes the session pooler on port 5432, which this network blocks
//   (TCP connects, TLS handshake times out). Port 6543 works, so we pass --db-url
//   explicitly. Everything else about the migration flow is standard.
//
// Usage:  npm run db:push          apply pending migrations
//         npm run db:push -- --dry-run    show what would be applied

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const envPath = path.join(root, '.env')

if (!fs.existsSync(envPath)) {
  console.error('ERROR: .env not found at', envPath)
  process.exit(1)
}

let dbUrl
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (!line || line.trim().startsWith('#')) continue
  const i = line.indexOf('=')
  if (i === -1) continue
  if (line.slice(0, i).trim() === 'SUPABASE_DB_URL') {
    dbUrl = line.slice(i + 1).trim()
    break
  }
}

if (!dbUrl) {
  console.error('ERROR: SUPABASE_DB_URL not set in .env')
  console.error('Expected: postgresql://postgres.<ref>:<url-encoded-password>@<host>:6543/postgres')
  process.exit(1)
}

// The transaction pooler (port 6543) runs PgBouncer in transaction mode, which
// does not support named prepared statements. The CLI's pgx driver caches them
// by default and fails with `prepared statement "..." already exists` (42P05)
// on the second migration. pgx honours this URL parameter to use the simple
// query protocol instead, which is what makes pushing through 6543 work at all.
// Verified 2026-09-03: migrations 012 and 013 applied through it.
if (!/default_query_exec_mode=/.test(dbUrl)) {
  dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'default_query_exec_mode=simple_protocol'
}

const passthrough = process.argv.slice(2)
const args = ['db', 'push', '--db-url', dbUrl, ...passthrough]

console.log(`> supabase db push --db-url <hidden> ${passthrough.join(' ')}`.trim())

const res = spawnSync('supabase', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

process.exit(res.status ?? 1)

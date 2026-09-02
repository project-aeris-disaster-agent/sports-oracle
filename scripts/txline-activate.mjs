#!/usr/bin/env node
// scripts/txline-activate.mjs
// Re-subscribes to TxLINE on Solana mainnet and activates a fresh X-Api-Token.
//
// This is an OPERATOR script. It signs an on-chain transaction with the wallet in
// TXLINE_SOLANA_PRIVATE_KEY, which is precisely why providers/txline.ts refuses
// to read that variable: a signing key belongs in a human-run step, never in the
// request path. Run it yourself, from a terminal, with the VPN off or on as you
// prefer; it needs Solana RPC and txline.txodds.com.
//
// ─── Why this exists ─────────────────────────────────────────────────────────
// TxLINE access is bought in 4-week terms (multiples of 28 days). Our token was
// activated on 2026-06-28 and the last successful upstream call was 2026-08-18;
// after that every soccer request returned 403 "API Token is invalid or expired"
// and nothing on our side noticed for two weeks. This script is the renewal, and
// it records the new term in provider_subscriptions so status.ts can degrade the
// sport BEFORE the next expiry instead of after.
//
// ─── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/txline-activate.mjs                  # dry run: preflight only, sends nothing
//   node scripts/txline-activate.mjs --execute        # subscribe on-chain, then activate
//   node scripts/txline-activate.mjs --activate-only --tx-sig <sig>
//                                                     # activation only, for a subscribe
//                                                     # that already confirmed
//   Options: --level 12 (default)  --weeks 4 (default; multiple of 4)
//
// The default is a dry run on purpose. It prints the wallet, its SOL, the ATA
// state, the on-chain pricing matrix, and exactly what --execute would do.
//
// ─── Service levels (mainnet, 2026-09) ───────────────────────────────────────
//   1   NFL, MLS, Premier League, World Cup, Int'l Friendlies   60s delay   free
//   12  same bundle                                             real-time   free
// Both still need SOL for the transaction fee. Neither needs TxL.

import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount,
} from '@solana/spl-token'
import { createClient } from '@supabase/supabase-js'

const { AnchorProvider, Program, Wallet } = anchor

// ─── Constants: mainnet only. Devnet is a different program AND a different host;
// mixing them is the documented cause of 403 signature failures and 504s. ─────
const RPC_URL      = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const API_ORIGIN   = 'https://txline.txodds.com'
const PROGRAM_ID   = new PublicKey('9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA')
const TXL_MINT     = new PublicKey('Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL')

const here = path.dirname(fileURLToPath(import.meta.url))
const IDL  = JSON.parse(fs.readFileSync(path.join(here, 'txline', 'txoracle.idl.json'), 'utf8'))

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? true) : dflt
}
const EXECUTE       = args.includes('--execute')
const ACTIVATE_ONLY = args.includes('--activate-only')
const LEVEL         = Number(flag('--level', 12))
const WEEKS         = Number(flag('--weeks', 4))
const TX_SIG_ARG    = flag('--tx-sig', null)

if (WEEKS < 4 || WEEKS % 4 !== 0 || WEEKS > 255) {
  fail(`--weeks must be a multiple of 4 (got ${WEEKS}); the contract takes it as u8.`)
}
if (ACTIVATE_ONLY && !TX_SIG_ARG) fail('--activate-only needs --tx-sig <signature>')

// ─── .env (never printed) ────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return {}
  const out = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    out[m[1]] = m[2].split(' #')[0].replace(/^#.*$/, '').trim().replace(/^["']|["']$/g, '')
  }
  return out
}
const env = { ...loadEnv(), ...process.env }

function loadKeypair() {
  const raw = env.TXLINE_SOLANA_PRIVATE_KEY
  if (!raw) fail('TXLINE_SOLANA_PRIVATE_KEY is not set')
  // Accept the two common encodings: base58 (Phantom export) or a JSON byte array
  // (solana-keygen). Nothing about the key is ever logged.
  if (raw.trim().startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  const bytes = bs58.decode(raw.trim())
  return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes.slice(0, 32))
}

function fail(msg) { console.error('\n✗ ' + msg); process.exit(1) }
const log = (...a) => console.log(...a)

// ─── Main ────────────────────────────────────────────────────────────────────
const keypair    = loadKeypair()
const connection = new Connection(RPC_URL, 'confirmed')
const wallet     = new Wallet(keypair)
const provider   = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
const program    = new Program(IDL, provider)

if (!program.programId.equals(PROGRAM_ID)) {
  fail(`IDL address ${program.programId.toBase58()} is not the mainnet program ${PROGRAM_ID.toBase58()}`)
}

log(`\nTxLINE activation  ·  ${EXECUTE ? 'EXECUTE' : ACTIVATE_ONLY ? 'ACTIVATE-ONLY' : 'DRY RUN'}`)
log('──────────────────────────────────────────────────────────')
log(`wallet        ${keypair.publicKey.toBase58()}`)

const lamports = await connection.getBalance(keypair.publicKey)
log(`SOL balance   ${(lamports / 1e9).toFixed(6)}`)
// Fee is ~5,000 lamports; an ATA, if it has to be created, is ~2,039,280 lamports rent.
if (lamports < 3_000_000) log('              ⚠ low: below ~0.003 SOL an ATA creation could fail. A subscribe alone is fine.')

// ── PDAs, exactly as the upstream example derives them ──────────────────────
const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')],   PROGRAM_ID)
const [treasuryPda]      = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], PROGRAM_ID)
const treasuryVault      = getAssociatedTokenAddressSync(TXL_MINT, treasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const userAta            = getAssociatedTokenAddressSync(TXL_MINT, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)

// ── Pricing matrix: confirms the level is real and free before spending anything
const matrix = await program.account.pricingMatrix.fetch(pricingMatrixPda)
log(`\npricing matrix (admin ${matrix.admin.toBase58()})`)
log('  level   TxL/week   sampling(s)   leagueBundle   marketBundle')
let chosen = null
for (const row of matrix.rows) {
  const id = Number(row.rowId)
  const price = Number(row.pricePerWeekToken)
  log(`  ${String(id).padStart(5)}   ${String(price).padStart(8)}   ${String(row.samplingIntervalSec).padStart(11)}   ${String(row.leagueBundleId).padStart(12)}   ${String(row.marketBundleId).padStart(12)}`)
  if (id === LEVEL) chosen = row
}
if (!chosen) fail(`service level ${LEVEL} is not in the on-chain pricing matrix`)
if (Number(chosen.pricePerWeekToken) !== 0) {
  fail(`service level ${LEVEL} costs ${chosen.pricePerWeekToken} TxL/week — this script only handles free levels`)
}
log(`\nchosen        level ${LEVEL}, ${WEEKS} weeks, standard bundle (no custom leagues)`)

// ── ATA state ────────────────────────────────────────────────────────────────
let ataExists = false
try { await getAccount(connection, userAta, 'confirmed', TOKEN_2022_PROGRAM_ID); ataExists = true } catch {}
log(`token account ${userAta.toBase58()}  ${ataExists ? 'exists' : 'MISSING (will be created, ~0.002 SOL rent)'}`)

if (!EXECUTE && !ACTIVATE_ONLY) {
  log('\nDry run complete. Nothing was sent. Re-run with --execute to subscribe and activate.\n')
  process.exit(0)
}

// ── Guest JWT ────────────────────────────────────────────────────────────────
async function guestJwt() {
  const r = await fetch(`${API_ORIGIN}/auth/guest/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!r.ok) fail(`guest/start returned ${r.status}`)
  const { token } = await r.json()
  if (!token) fail('guest/start returned no token')
  return token
}

// ── Subscribe ────────────────────────────────────────────────────────────────
let txSig = TX_SIG_ARG
if (!ACTIVATE_ONLY) {
  if (!ataExists) {
    log('\ncreating Token-2022 associated token account…')
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
      keypair.publicKey, userAta, keypair.publicKey, TXL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ))
    const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
    log(`  created  ${sig}`)
  }

  log(`\nsubscribing on-chain: level ${LEVEL}, ${WEEKS} weeks…`)
  const tx = await program.methods
    .subscribe(LEVEL, WEEKS)
    .accounts({
      user:                   keypair.publicKey,
      pricingMatrix:          pricingMatrixPda,
      tokenMint:              TXL_MINT,
      userTokenAccount:       userAta,
      tokenTreasuryVault:     treasuryVault,
      tokenTreasuryPda:       treasuryPda,
      tokenProgram:           TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram:          SystemProgram.programId,
    })
    .transaction()

  const bh = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = bh.blockhash
  tx.feePayer = keypair.publicKey
  tx.sign(keypair)
  txSig = await connection.sendRawTransaction(tx.serialize())
  await connection.confirmTransaction({ signature: txSig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed')
  log(`  confirmed  ${txSig}`)
  log(`  https://solscan.io/tx/${txSig}`)
}

// ── Activate ─────────────────────────────────────────────────────────────────
// Message is `${txSig}:${leagues.join(',')}:${jwt}`; with no custom leagues the
// middle segment is empty, giving `${txSig}::${jwt}`. Signed by the SAME wallet
// that sent subscribe, as a NaCl detached signature, base64.
log('\nactivating API token…')
const jwt      = await guestJwt()
const leagues  = []
const message  = new TextEncoder().encode(`${txSig}:${leagues.join(',')}:${jwt}`)
const sigBytes = nacl.sign.detached(message, keypair.secretKey)
const walletSignature = Buffer.from(sigBytes).toString('base64')

const act = await fetch(`${API_ORIGIN}/api/token/activate`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body:    JSON.stringify({ txSig, walletSignature, leagues }),
})
const actBody = await act.text()
if (!act.ok) fail(`token/activate returned ${act.status}: ${actBody.slice(0, 300)}`)
let apiToken
try { apiToken = JSON.parse(actBody).token ?? actBody } catch { apiToken = actBody.trim() }
if (!apiToken) fail('activation returned an empty token')

// ── Verify it actually works before declaring victory ────────────────────────
const epochDay = Math.floor(Date.now() / 86400000)
const probe = await fetch(`${API_ORIGIN}/api/fixtures/snapshot?startEpochDay=${epochDay}`, {
  headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': apiToken },
})
log(`  verification GET /api/fixtures/snapshot → ${probe.status}`)
if (!probe.ok) fail(`the new token was issued but a data call returned ${probe.status}: ${(await probe.text()).slice(0, 200)}`)
const fixtures = await probe.json()
log(`  ${Array.isArray(fixtures) ? fixtures.length : '?'} fixtures visible`)

// ── Record the term so status.ts can warn before it lapses ───────────────────
const activatedAt = new Date()
const expiresAt   = new Date(activatedAt.getTime() + WEEKS * 7 * 86400000)
if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const { error } = await sb.from('provider_subscriptions').upsert({
    provider: 'txline', service_level: LEVEL, wallet: keypair.publicKey.toBase58(),
    activated_at: activatedAt.toISOString(), expires_at: expiresAt.toISOString(),
    term_weeks: WEEKS, note: `subscribe tx ${txSig}`, updated_at: activatedAt.toISOString(),
  })
  log(error ? `  ⚠ could not record subscription: ${error.message}` : `  recorded in provider_subscriptions, expires ${expiresAt.toISOString().slice(0, 10)}`)
} else {
  log('  ⚠ Supabase env not found; subscription term NOT recorded')
}

log('\n──────────────────────────────────────────────────────────')
log('NEW API TOKEN (set as TXLINE_API_TOKEN in Vercel AND .env, then redeploy):\n')
log(apiToken)
log(`\nTerm ends ${expiresAt.toISOString().slice(0, 10)}. Re-run this script before then.\n`)

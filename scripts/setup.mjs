#!/usr/bin/env node
/**
 * One-command setup:
 *   1. reads DATABASE_URL and rewrites the Prisma datasource provider if needed
 *   2. generates the Prisma client
 *   3. pushes the schema (creates tables)
 *   4. seeds the bootstrap admin + default brand voice + starter knowledge
 *   5. prints the login credentials and webhook URLs
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd) => {
  console.log(`\n\x1b[36m> ${cmd}\x1b[0m`)
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

// ── 0. create .env from the template on a fresh checkout ─────────────────
const envPath = resolve(root, '.env')
const examplePath = resolve(root, '.env.example')
const databaseExists = existsSync(resolve(root, 'dev.db')) || existsSync(resolve(root, 'prisma/dev.db'))
if (!existsSync(envPath) && existsSync(examplePath)) {
  let tpl = readFileSync(examplePath, 'utf8')
  const secret = () => randomBytes(32).toString('hex')
  tpl = tpl
    .replace('change-me-to-a-long-random-string-please-32chars', secret())
    .replace('change-me-too-another-long-random-string-32chars', secret())
    // No API key yet, so start in mock mode; the Settings page says so loudly.
    .replace(/^AI_MOCK="0"$/m, 'AI_MOCK="1"')
  writeFileSync(envPath, tpl)
  console.log('\x1b[32m* created .env from .env.example\x1b[0m')
  console.log('  - generated fresh APP_SECRET / AUTH_SECRET')
  console.log('  - AI_MOCK="1" (zero-cost mock replies). Add a provider key and set it to "0".')
  if (databaseExists) {
    console.log('\x1b[33m  ! a database already exists but .env did not, so the new secrets will not\x1b[0m')
    console.log('\x1b[33m    match the stored login hashes or encrypted platform tokens.\x1b[0m')
    console.log('\x1b[33m    Restore your previous .env, or wipe the DB and re-run: rm dev.db\x1b[0m')
  }
}

// ── 1. load .env ─────────────────────────────────────────────────────────
let dbUrl = process.env.DATABASE_URL || ''
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[m[1]]) process.env[m[1]] = value
    if (m[1] === 'DATABASE_URL') dbUrl = value
  }
}
if (!dbUrl) dbUrl = 'file:./dev.db'

const isPostgres = /^postgres(ql)?:\/\//.test(dbUrl)
const wantedProvider = isPostgres ? 'postgresql' : 'sqlite'

// ── 2. sync schema provider ──────────────────────────────────────────────
const schemaPath = resolve(root, 'prisma/schema.prisma')
let schema = readFileSync(schemaPath, 'utf8')
const current = schema.match(/datasource db \{\s*provider = "(\w+)"/)?.[1]
if (current !== wantedProvider) {
  schema = schema.replace(/(datasource db \{\s*provider = ")\w+(")/, `$1${wantedProvider}$2`)
  writeFileSync(schemaPath, schema)
  console.log(`\x1b[33m* switched Prisma provider ${current} -> ${wantedProvider}\x1b[0m`)
} else {
  console.log(`* Prisma provider: ${wantedProvider}`)
}

if (!isPostgres) {
  const file = dbUrl.replace(/^file:/, '')
  const dir = dirname(resolve(root, 'prisma', file))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── 3. generate + push + seed ────────────────────────────────────────────
run('npx prisma generate')
run('npx prisma db push')
run('npx tsx prisma/seed.ts')

// ── 4. summary ───────────────────────────────────────────────────────────
const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
console.log(`
\x1b[32m=== ReplyPilot is ready ===\x1b[0m

  Database      ${dbUrl}
  Web app       ${appUrl}
  Worker        ${process.env.ENABLE_INPROC_WORKER === '0' ? 'separate process -> npm run worker' : 'in-process (ENABLE_INPROC_WORKER=1)'}

  \x1b[1mSign in\x1b[0m       ${process.env.BOOTSTRAP_EMAIL || 'admin@replypilot.local'}
                ${process.env.BOOTSTRAP_PASSWORD || 'replypilot123'}

  \x1b[1mWebhooks\x1b[0m      ${appUrl}/api/webhooks/meta
                ${appUrl}/api/webhooks/tiktok
                ${appUrl}/api/webhooks/x
                ${appUrl}/api/webhooks/linkedin

  Next:  npm run dev   ->   open /settings for the credential checklist
`)

#!/usr/bin/env node
// Opt-in schema push at build time, for targets with no shell (Vercel).
//
// Set DB_PUSH_AT_BUILD=1 in the build environment and `prisma db push` runs
// between `prisma generate` and `next build`, so the very first deploy after
// adding DATABASE_URL creates every table — no local machine required.
//
// Safety:
//  - Idempotent. A second push against an in-sync database is a no-op.
//  - Never drops data: plain `db push` refuses destructive changes without
//    --accept-data-loss, and we never pass it, so a conflicting schema fails
//    the build loudly instead of eating production rows.
//  - Off by default. Local/Docker flows keep using `npm run db:push`.
//
// Connection string: migrations should not go through a pooler, so if the
// platform also exposes a non-pooled URL (Neon's Vercel integration does:
// POSTGRES_URL_NON_POOLING / DATABASE_URL_NON_POOLING) we prefer it for the
// push only, without touching what the app itself connects with.
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.DB_PUSH_AT_BUILD !== '1') {
  console.log('[db-push] DB_PUSH_AT_BUILD unset — skipping schema push')
  process.exit(0)
}

const direct =
  process.env.DATABASE_URL_NON_POOLING ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL

if (!direct) {
  console.error('[db-push] DB_PUSH_AT_BUILD=1 but DATABASE_URL is not set in the build environment.')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
console.log('[db-push] pushing schema to the configured database…')
execSync('npx prisma db push', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: direct },
})
console.log('[db-push] schema push complete')

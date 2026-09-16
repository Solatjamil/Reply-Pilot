#!/usr/bin/env node
/**
 * Rewrites the `provider` in prisma/schema.prisma to match DATABASE_URL.
 *
 * The schema is committed with provider = "sqlite" so the app runs with zero
 * setup locally, but Prisma emits SQL in the dialect named there — so a Postgres
 * deployment MUST have the schema switched before `prisma generate`, otherwise
 * the client is built for SQLite and fails at runtime against Postgres.
 *
 * This only edits the schema. It never touches the database, so it is safe to
 * run during a build (unlike `prisma db push`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const envPath = resolve(root, '.env')
  if (!existsSync(envPath)) return ''
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => /^\s*DATABASE_URL\s*=/.test(l))
  return (line?.split('=')[1] ?? '').replace(/^["']|["']$/g, '').trim()
}

export function syncProvider({ quiet = false } = {}) {
  const url = databaseUrl()
  const wanted = /^postgres(ql)?:\/\//.test(url) ? 'postgresql' : 'sqlite'
  const schemaPath = resolve(root, 'prisma/schema.prisma')
  const schema = readFileSync(schemaPath, 'utf8')
  const current = schema.match(/datasource db \{\s*provider = "(\w+)"/)?.[1]

  if (current === wanted) {
    if (!quiet) console.log(`prisma provider already "${wanted}"`)
    return wanted
  }

  writeFileSync(schemaPath, schema.replace(/(datasource db \{\s*provider = ")\w+(")/, `$1${wanted}$2`))
  console.log(`\x1b[33m* prisma provider ${current} -> ${wanted}\x1b[0m`)
  return wanted
}

// Only run when executed directly (db-push.mjs imports this module).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncProvider()
}

#!/usr/bin/env node
// Rewrites the Prisma datasource provider to match DATABASE_URL, then pushes.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let dbUrl = process.env.DATABASE_URL || ''
if (!dbUrl) {
  const env = readFileSync(resolve(root, '.env'), 'utf8')
  dbUrl = env.match(/^\s*DATABASE_URL\s*=\s*(.*)$/m)?.[1]?.replace(/["']/g, '') || 'file:./dev.db'
}
const wanted = /^postgres(ql)?:\/\//.test(dbUrl) ? 'postgresql' : 'sqlite'
const schemaPath = resolve(root, 'prisma/schema.prisma')
let schema = readFileSync(schemaPath, 'utf8')
schema = schema.replace(/(datasource db \{\s*provider = ")\w+(")/, `$1${wanted}$2`)
writeFileSync(schemaPath, schema)
execSync('npx prisma generate && npx prisma db push', { cwd: root, stdio: 'inherit' })

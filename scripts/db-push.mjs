#!/usr/bin/env node
// Syncs the Prisma datasource provider to match DATABASE_URL, then pushes.
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncProvider } from './sync-provider.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
syncProvider()
execSync('npx prisma generate && npx prisma db push', { cwd: root, stdio: 'inherit' })

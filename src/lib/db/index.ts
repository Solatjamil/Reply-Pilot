
import { PrismaClient } from '@/generated/prisma/client'
import { makeAdapter } from '@/lib/db/adapter'
import { assertDatabaseConfig } from '@/lib/env'

// Throws a readable config error on Vercel if DATABASE_URL is missing or not
// Postgres, instead of letting queries fail against an ephemeral SQLite file.
assertDatabaseConfig()

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: makeAdapter(),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma

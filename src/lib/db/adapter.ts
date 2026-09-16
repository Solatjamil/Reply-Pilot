

/**
 * Builds the Prisma driver adapter for whichever database DATABASE_URL points
 * at. SQLite (better-sqlite3) is the zero-setup default; Postgres (pg) is the
 * production recommendation.
 *
 * NOTE: `prisma/schema.prisma` has a single `provider` value, so when you move
 * from SQLite to Postgres run `npm run setup` — it rewrites the provider,
 * regenerates the client and pushes the schema.
 */
export function databaseProvider(url: string = process.env.DATABASE_URL ?? ''): 'postgresql' | 'sqlite' {
  return url.startsWith('postgres://') || url.startsWith('postgresql://') ? 'postgresql' : 'sqlite'
}

export function makeAdapter() {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db'

  if (databaseProvider(url) === 'postgresql') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg')
    return new PrismaPg({ connectionString: url })
  }

  const filename = url.replace(/^file:/, '')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3') as typeof import('@prisma/adapter-better-sqlite3')
  return new PrismaBetterSqlite3({ url: filename })
}

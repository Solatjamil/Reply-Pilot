
import { prisma } from '@/lib/db'
import { decrypt, decryptJson, encrypt, encryptJson } from '@/lib/crypto'
import { logEvent } from '@/lib/log'
import { PLATFORMS, type Platform } from './catalog'
import type { AccountRecord, PlatformAdapter, AccountSecrets } from './types'
import { metaAdapter } from './adapters/meta'
import { youtubeAdapter } from './adapters/youtube'
import { xAdapter } from './adapters/x'
import { linkedinAdapter } from './adapters/linkedin'
import { tiktokAdapter } from './adapters/tiktok'

export const ADAPTERS: Record<string, PlatformAdapter> = {
  meta: metaAdapter,
  youtube: youtubeAdapter,
  x: xAdapter,
  linkedin: linkedinAdapter,
  tiktok: tiktokAdapter,
}

/** Maps a stored platform to the adapter that talks to its API. */
export function adapterFor(platform: string): PlatformAdapter | undefined {
  switch (platform) {
    case 'facebook_page':
    case 'instagram':
    case 'messenger':
      return ADAPTERS.meta
    case 'youtube':
      return ADAPTERS.youtube
    case 'x':
      return ADAPTERS.x
    case 'linkedin_org':
    case 'linkedin_person':
      return ADAPTERS.linkedin
    case 'tiktok':
      return ADAPTERS.tiktok
    default:
      return undefined
  }
}

export function capabilitiesFor(platform: string) {
  return PLATFORMS[platform as Platform]?.capabilities
}

type AccountRow = Awaited<ReturnType<typeof prisma.account.findUnique>>

export function toAccountRecord(row: NonNullable<AccountRow>): AccountRecord {
  const meta = PLATFORMS[row.platform as Platform]
  const storedCaps = decryptJsonSafe(row.capabilities)
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    platform: row.platform as Platform,
    platformUid: row.platformUid,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    profileUrl: row.profileUrl,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    idToken: decrypt(row.idToken),
    expiresAt: row.expiresAt,
    scope: row.scope,
    secrets: (decryptJsonSafe(row.secrets) as AccountSecrets | null) ?? {},
    capabilities: (storedCaps as AccountRecord['capabilities']) ?? meta?.capabilities ?? ({} as AccountRecord['capabilities']),
    regionCode: row.regionCode,
    status: row.status,
  }
}

function decryptJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null
  const parsed = decryptJson(raw)
  if (parsed !== null) return parsed
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function getAccountRecord(id: string): Promise<AccountRecord | null> {
  const row = await prisma.account.findUnique({ where: { id } })
  return row ? toAccountRecord(row) : null
}

export async function listAccountRecords(workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<AccountRecord[]> {
  const rows = await prisma.account.findMany({
    where: { workspaceId, ...(opts.activeOnly ? { status: 'active' } : {}) },
    orderBy: { connectedAt: 'desc' },
  })
  return rows.map(toAccountRecord)
}

/** Refreshes an account's token when it is close to expiry. */
export async function ensureFreshToken(accountId: string): Promise<AccountRecord | null> {
  const row = await prisma.account.findUnique({ where: { id: accountId } })
  if (!row) return null
  const record = toAccountRecord(row)

  const needsRefresh =
    record.expiresAt && record.expiresAt.getTime() - Date.now() < 10 * 60_000

  if (!needsRefresh) return record

  const adapter = adapterFor(record.platform)
  if (!adapter?.refreshToken) {
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      await prisma.account.update({
        where: { id: accountId },
        data: { status: 'error', lastError: 'Access token expired and this platform does not issue refresh tokens — reconnect the account.' },
      })
      await logEvent({ accountId, workspaceId: record.workspaceId, type: 'token.expired', level: 'warn', message: `${record.platform} token expired, reconnect required` })
    }
    return record
  }

  try {
    const bundle = await adapter.refreshToken(record)
    if (!bundle?.accessToken) return record
    await prisma.account.update({
      where: { id: accountId },
      data: {
        accessToken: encrypt(bundle.accessToken),
        refreshToken: bundle.refreshToken ? encrypt(bundle.refreshToken) : row.refreshToken,
        expiresAt: bundle.expiresAt ?? row.expiresAt,
        rawTokens: bundle.raw ? encryptJson(bundle.raw) : row.rawTokens,
        status: 'active',
        lastError: null,
        errorSince: null,
      },
    })
    await logEvent({ accountId, workspaceId: record.workspaceId, type: 'token.refreshed', level: 'debug', message: `${record.platform} token refreshed` })
    return await getAccountRecord(accountId)
  } catch (err) {
    const msg = (err as Error).message
    await prisma.account.update({
      where: { id: accountId },
      data: { status: 'error', lastError: `Token refresh failed: ${msg}`, errorSince: row.errorSince ?? new Date() },
    })
    await logEvent({ accountId, workspaceId: record.workspaceId, type: 'token.refresh_failed', level: 'error', message: msg })
    return record
  }
}

/** Marks an account as failing (bad credentials, revoked app, etc.). */
export async function markAccountError(accountId: string, workspaceId: string, message: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: 'error', lastError: message.slice(0, 1000), errorSince: new Date() },
  })
  await logEvent({ accountId, workspaceId, type: 'account.error', level: 'error', message })
}

export async function markAccountHealthy(accountId: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: 'active', lastError: null, errorSince: null, lastSyncAt: new Date() },
  })
}

export { encrypt, encryptJson, decrypt }

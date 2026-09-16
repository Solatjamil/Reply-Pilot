import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { maskToken } from '@/lib/crypto'
import { decrypt } from '@/lib/crypto'
import { queueStats } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

export async function GET() {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const [accounts, stats] = await Promise.all([
    prisma.account.findMany({ where: { workspaceId: session.wid }, orderBy: { connectedAt: 'desc' }, include: { automation: true } }),
    queueStats(session.wid),
  ])

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      platformUid: a.platformUid,
      name: a.name,
      handle: a.handle,
      avatarUrl: a.avatarUrl,
      profileUrl: a.profileUrl,
      status: a.status,
      lastError: a.lastError,
      lastSyncAt: a.lastSyncAt,
      connectedAt: a.connectedAt,
      expiresAt: a.expiresAt,
      tokenPreview: maskToken(decrypt(a.accessToken)),
      capabilities: safeJson(a.capabilities),
      automation: a.automation
        ? {
            replyToComments: a.automation.replyToComments,
            replyToDms: a.automation.replyToDms,
            autoSendEnabled: a.automation.autoSendEnabled,
            autoSendThreshold: a.automation.autoSendThreshold,
          }
        : null,
    })),
    queue: stats,
  })
}

function safeJson(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

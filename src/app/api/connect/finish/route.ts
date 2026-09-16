import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { decrypt, decryptJson, encrypt, encryptJson } from '@/lib/crypto'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { capabilitiesFor } from '@/lib/platforms'
import type { ConnectableProfile } from '@/lib/platforms/types'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  id: z.string().min(1),
  selected: z.array(z.string()).min(1, 'Pick at least one profile to attach'),
})

interface PendingTokens {
  accessToken: string
  refreshToken?: string | null
  idToken?: string | null
  expiresAt?: string | null
  scope?: string | null
}

export async function POST(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
  }

  const pending = await prisma.job.findUnique({ where: { id: parsed.data.id } })
  if (!pending || pending.workspaceId !== session.wid) {
    return NextResponse.json({ error: 'This connection session no longer exists.' }, { status: 404 })
  }
  if (pending.runAt && pending.runAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'This connection session expired. Please reconnect.' }, { status: 410 })
  }

  const payload = decryptJson<{ provider: string; profiles: ConnectableProfile[]; tokens: PendingTokens }>(pending.payload)
  if (!payload?.profiles?.length) {
    return NextResponse.json({ error: 'No profiles found in this connection session.' }, { status: 400 })
  }

  const accessToken = decrypt(payload.tokens.accessToken)
  if (!accessToken) {
    return NextResponse.json({ error: 'Stored token could not be decrypted — has APP_SECRET changed?' }, { status: 500 })
  }

  const created: string[] = []
  const updated: string[] = []

  for (const key of parsed.data.selected) {
    const profile = payload.profiles.find((p) => `${p.platform}:${p.platformUid}` === key)
    if (!profile) continue

    const caps = { ...(capabilitiesFor(profile.platform) ?? {}), ...(profile.capabilities ?? {}) }
    const secrets = encryptJson(profile.secrets ?? {})
    const expiresAt = payload.tokens.expiresAt ? new Date(payload.tokens.expiresAt) : null

    const existing = await prisma.account.findUnique({
      where: {
        workspaceId_platform_platformUid: {
          workspaceId: session.wid,
          platform: profile.platform,
          platformUid: profile.platformUid,
        },
      },
    })

    const data = {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      regionCode: profile.regionCode ?? null,
      accessToken: encrypt(accessToken),
      refreshToken: payload.tokens.refreshToken ? encrypt(payload.tokens.refreshToken) : null,
      idToken: payload.tokens.idToken ? encrypt(payload.tokens.idToken) : null,
      expiresAt,
      scope: payload.tokens.scope ?? null,
      rawTokens: encryptJson(payload.tokens),
      secrets,
      capabilities: JSON.stringify(caps),
      status: profile.warning && !caps.readComments && !caps.readDms ? 'pending_access' : 'active',
      lastError: null,
      errorSince: null,
      connectedAt: new Date(),
    }

    const account = existing
      ? await prisma.account.update({ where: { id: existing.id }, data })
      : await prisma.account.create({ data: { workspaceId: session.wid, platform: profile.platform, platformUid: profile.platformUid, ...data } })

    if (existing) updated.push(account.id)
    else created.push(account.id)

    // Every account gets an automation config (defaults are safe: auto-send on
    // at 0.82 confidence, everything else queued for approval).
    await prisma.automationConfig.upsert({
      where: { accountId: account.id },
      create: { workspaceId: session.wid, accountId: account.id },
      update: {},
    })

    await enqueue({ type: 'sync_account', accountId: account.id, workspaceId: session.wid, payload: { accountId: account.id }, key: `sync:${account.id}` })
  }

  await prisma.job.delete({ where: { id: pending.id } }).catch(() => undefined)

  await logEvent({
    workspaceId: session.wid,
    type: 'account.connected',
    message: `Attached ${created.length + updated.length} profile(s) via ${payload.provider}`,
    data: { created, updated },
  })

  return NextResponse.json({ ok: true, created: created.length, updated: updated.length })
}

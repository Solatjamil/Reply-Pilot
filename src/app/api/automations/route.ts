import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  accountId: z.string().min(1),
  replyToComments: z.boolean().optional(),
  replyToDms: z.boolean().optional(),
  replyToMentions: z.boolean().optional(),
  autoSendEnabled: z.boolean().optional(),
  autoSendThreshold: z.number().min(0).max(1).optional(),
  reviewThreshold: z.number().min(0).max(1).optional(),
  minDelaySeconds: z.number().int().min(0).max(3600).optional(),
  maxDelaySeconds: z.number().int().min(0).max(7200).optional(),
  maxAutoPerHour: z.number().int().min(0).max(5000).optional(),
  maxAutoPerDay: z.number().int().min(0).max(50000).optional(),
  maxRepliesPerUser: z.number().int().min(0).max(100).optional(),
  skipOwnComments: z.boolean().optional(),
  skipRepliesToUs: z.boolean().optional(),
  skipLowEffort: z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().optional(),
  language: z.string().optional(),
  brandVoiceId: z.string().nullable().optional(),
  sentiment: z.string().optional(),
})

export async function GET() {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const rows = await prisma.automationConfig.findMany({ where: { workspaceId: session.wid }, include: { account: { select: { id: true, name: true, platform: true, handle: true } } } })
  return NextResponse.json({ automations: rows })
}

export async function PATCH(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })

  const { accountId, ...data } = parsed.data
  const account = await prisma.account.findFirst({ where: { id: accountId, workspaceId: session.wid } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  if (data.autoSendThreshold !== undefined && data.reviewThreshold !== undefined && data.reviewThreshold > data.autoSendThreshold) {
    return NextResponse.json({ error: 'Review threshold must be lower than the auto-send threshold.' }, { status: 400 })
  }
  if (data.minDelaySeconds !== undefined && data.maxDelaySeconds !== undefined && data.maxDelaySeconds < data.minDelaySeconds) {
    return NextResponse.json({ error: 'Max delay must be greater than min delay.' }, { status: 400 })
  }

  const row = await prisma.automationConfig.upsert({
    where: { accountId },
    create: { workspaceId: session.wid, accountId, ...data },
    update: data,
  })
  return NextResponse.json({ ok: true, automation: row })
}

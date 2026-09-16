import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { generateReplyDraft } from '@/lib/ai/reply-engine'
import { adapterFor, getAccountRecord } from '@/lib/platforms'
import { PLATFORMS, type Platform } from '@/lib/platforms/catalog'
import { bumpUsage } from '@/lib/ingest'

export const dynamic = 'force-dynamic'

const schema = z.object({
  action: z.enum(['approve', 'reject', 'edit', 'ignore', 'regenerate', 'escalate', 'handoff']),
  text: z.string().max(10000).optional(),
  reason: z.string().max(500).optional(),
  sendNow: z.boolean().optional(),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
  const { action, text, reason, sendNow } = parsed.data

  const draft = await prisma.draft.findFirst({ where: { id, workspaceId: session.wid }, include: { account: true, comment: true, message: true, thread: true } })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })

  const account = await getAccountRecord(draft.accountId)
  const platformLabel = PLATFORMS[draft.account.platform as Platform]?.label ?? draft.account.platform

  switch (action) {
    case 'reject':
    case 'ignore': {
      await prisma.draft.update({
        where: { id },
        data: { status: action === 'reject' ? 'rejected' : 'ignored', action: 'escalate', decidedBy: session.sub, decidedAt: new Date(), error: reason ?? null },
      })
      await bumpUsage(draft.accountId, draft.workspaceId, action === 'reject' ? 'rejected' : 'escalated')
      await logEvent({
        workspaceId: draft.workspaceId,
        accountId: draft.accountId,
        type: action === 'reject' ? 'draft.rejected' : 'draft.ignored',
        message: reason ?? `${action} by ${session.email}`,
        data: { draftId: id },
      })
      return NextResponse.json({ ok: true, status: action })
    }

    case 'escalate': {
      await prisma.draft.update({ where: { id }, data: { status: 'pending', action: 'escalate', decidedBy: session.sub, decidedAt: new Date() } })
      if (draft.threadId) await prisma.thread.update({ where: { id: draft.threadId }, data: { handedToHuman: true } })
      await bumpUsage(draft.accountId, draft.workspaceId, 'escalated')
      return NextResponse.json({ ok: true, status: 'escalated' })
    }

    case 'handoff': {
      if (draft.threadId) await prisma.thread.update({ where: { id: draft.threadId }, data: { handedToHuman: true, open: true } })
      await prisma.draft.updateMany({ where: { threadId: draft.threadId, status: { in: ['pending', 'scheduled'] } }, data: { status: 'ignored', action: 'escalate' } })
      await logEvent({
        workspaceId: draft.workspaceId,
        accountId: draft.accountId,
        type: 'thread.handoff',
        message: `Automation paused for this ${platformLabel} conversation — a human has taken over.`,
      })
      return NextResponse.json({ ok: true, status: 'handoff' })
    }

    case 'regenerate': {
      if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
      await prisma.draft.update({ where: { id }, data: { status: 'rejected', action: 'escalate', decidedBy: session.sub, decidedAt: new Date() } })

      const ctx = draft.commentId
        ? {
            workspaceId: draft.workspaceId,
            accountId: draft.accountId,
            kind: 'comment_reply' as const,
            platform: account.platform as Platform,
            text: draft.comment?.text ?? '',
            authorName: draft.comment?.authorName,
            authorHandle: draft.comment?.authorHandle,
            commentId: draft.commentId,
            force: true,
          }
        : {
            workspaceId: draft.workspaceId,
            accountId: draft.accountId,
            kind: 'dm_reply' as const,
            platform: account.platform as Platform,
            text: draft.message?.text ?? '',
            messageId: draft.messageId,
            threadId: draft.threadId,
            force: true,
          }

      if (!ctx.text) return NextResponse.json({ error: 'Nothing to regenerate from.' }, { status: 400 })
      const result = await generateReplyDraft(ctx)
      await logEvent({ workspaceId: draft.workspaceId, accountId: draft.accountId, type: 'draft.regenerated', message: `Regenerated draft (confidence ${result.confidence.toFixed(2)})` })
      return NextResponse.json({ ok: true, draftId: result.draftId, confidence: result.confidence, action: result.action, text: result.text })
    }

    case 'edit': {
      if (typeof text !== 'string' || !text.trim()) return NextResponse.json({ error: 'Edited text is required' }, { status: 400 })
      const limit = limits(draft.account.platform)
      if (text.length > limit) return NextResponse.json({ error: `${platformLabel} limits this reply to ${limit} characters.` }, { status: 400 })
      await prisma.draft.update({
        where: { id },
        data: { text: text.trim(), status: sendNow ? 'approved' : 'pending', action: sendNow ? 'auto_send' : 'review', decidedBy: session.sub, decidedAt: new Date(), error: null },
      })
      if (!sendNow) return NextResponse.json({ ok: true, status: 'edited' })
      break // fall through to approve/send
    }

    case 'approve': {
      break
    }
  }

  // approve (or edit+sendNow): hand off to the queue worker
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  const adapter = adapterFor(account.platform)
  const needed = draft.kind === 'comment_reply' ? 'sendCommentReply' : draft.kind === 'private_reply' ? 'sendPrivateReply' : 'sendDm'
  const capOk =
    draft.kind === 'comment_reply' ? account.capabilities?.replyToComment : draft.kind === 'private_reply' ? account.capabilities?.privateReplyFromComment : account.capabilities?.sendDm

  if (!adapter || !(needed in adapter) || capOk === false) {
    await prisma.draft.update({
      where: { id },
      data: { status: 'failed', error: `${platformLabel} does not permit this action with your current API access.` },
    })
    return NextResponse.json(
      { ok: false, error: `${platformLabel} does not permit this action with your current API access. See Settings → Platform access.` },
      { status: 409 },
    )
  }

  await prisma.draft.update({
    where: { id },
    data: { status: 'approved', action: 'auto_send', decidedBy: session.sub, decidedAt: new Date(), scheduledFor: new Date(), error: null },
  })
  await enqueue({
    type: 'send_draft',
    accountId: draft.accountId,
    workspaceId: draft.workspaceId,
    payload: { draftId: id },
    key: `send:${id}:${Date.now()}`,
    priority: 50,
  })

  return NextResponse.json({ ok: true, status: 'queued' })
}

function limits(platform: string): number {
  const map: Record<string, number> = { x: 280, tiktok: 150, instagram: 2200, messenger: 2000, facebook_page: 8000, youtube: 10000, linkedin_org: 1200, linkedin_person: 1200 }
  return map[platform] ?? 2000
}

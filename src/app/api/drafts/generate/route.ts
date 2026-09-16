import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { enqueue } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

const schema = z.object({
  commentId: z.string().optional(),
  messageId: z.string().optional(),
})

/** Manually ask ReplyPilot to draft a reply for a comment/DM that was skipped. */
export async function POST(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'commentId or messageId is required' }, { status: 400 })
  const { commentId, messageId } = parsed.data

  let accountId: string
  let workspaceId: string
  let kind: 'comment_reply' | 'dm_reply'
  let targetId: string

  if (commentId) {
    const comment = await prisma.comment.findFirst({ where: { id: commentId, workspaceId: session.wid } })
    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    accountId = comment.accountId
    workspaceId = comment.workspaceId
    kind = 'comment_reply'
    targetId = comment.id
  } else {
    const message = await prisma.message.findFirst({ where: { id: messageId, workspaceId: session.wid } })
    if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    accountId = message.accountId
    workspaceId = message.workspaceId
    kind = 'dm_reply'
    targetId = message.id
  }

  await enqueue({
    type: 'generate_draft',
    accountId,
    workspaceId,
    payload: { kind, commentId: kind === 'comment_reply' ? targetId : undefined, messageId: kind === 'dm_reply' ? targetId : undefined, force: true },
    key: `manual:${kind}:${targetId}:${Date.now()}`,
    priority: 60,
  })

  return NextResponse.json({ ok: true, queued: true })
}

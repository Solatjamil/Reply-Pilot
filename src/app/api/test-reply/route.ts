import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { generateReplyDraft } from '@/lib/ai/reply-engine'
import { type Platform } from '@/lib/platforms/catalog'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const schema = z.object({
  accountId: z.string().optional(),
  platform: z.string().default('instagram'),
  kind: z.enum(['comment_reply', 'dm_reply', 'private_reply']).default('comment_reply'),
  comment: z.string().min(1).max(4000),
  post: z.string().max(4000).optional(),
  history: z.array(z.object({ role: z.enum(['customer', 'brand']), text: z.string().max(2000) })).max(10).optional(),
})

/** Brand-voice playground: scores a sample comment without persisting anything. */
export async function POST(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
  const input = parsed.data

  const account = input.accountId
    ? await prisma.account.findFirst({ where: { id: input.accountId, workspaceId: session.wid } })
    : await prisma.account.findFirst({ where: { workspaceId: session.wid }, orderBy: { connectedAt: 'desc' } })

  if (!account) return NextResponse.json({ error: 'Connect a profile first — the playground uses that profile\'s automation rules.' }, { status: 400 })

  try {
    const started = Date.now()
    const draft = await generateReplyDraft({
      workspaceId: session.wid,
      accountId: account.id,
      kind: input.kind,
      platform: account.platform as Platform,
      text: input.comment,
      authorName: 'Test Customer',
      post: input.post ? { text: input.post, type: 'post' } : null,
      history: input.history,
      dryRun: true,
    })

    return NextResponse.json({
      ok: true,
      account: { id: account.id, name: account.name, platform: account.platform },
      draft: {
        text: draft.text,
        alternates: draft.alternates,
        confidence: draft.confidence,
        action: draft.action,
        intent: draft.intent,
        sentiment: draft.sentiment,
        language: draft.language,
        reasoning: draft.reasoning,
        flaggedFor: draft.flaggedFor,
        llmProvider: draft.llmProvider,
        llmModel: draft.llmModel,
        costUsd: draft.costUsd,
        knowledgeUsed: draft.knowledge.map((k) => ({ title: k.title, score: k.score })),
      },
      latencyMs: Date.now() - started,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}

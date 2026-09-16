import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const url = new URL(req.url)
  const days = Math.min(Number(url.searchParams.get('days') ?? 14), 90)
  const since = new Date(Date.now() - days * 86_400_000)

  const [daily, byAccount, intents, totals] = await Promise.all([
    prisma.usageStat.findMany({
      where: { workspaceId: session.wid, day: { gte: since.toISOString().slice(0, 10) } },
      orderBy: { day: 'asc' },
    }),
    prisma.account.findMany({
      where: { workspaceId: session.wid },
      select: {
        id: true,
        name: true,
        platform: true,
        handle: true,
        _count: { select: { comments: true, threads: true, drafts: true } },
      },
    }),
    prisma.draft.groupBy({
      by: ['intent'],
      where: { workspaceId: session.wid, createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { intent: 'desc' } },
    }),
    prisma.$transaction([
      prisma.draft.count({ where: { workspaceId: session.wid, status: 'sent', sentAt: { gte: since } } }),
      prisma.draft.count({ where: { workspaceId: session.wid, action: 'auto_send', status: 'sent', sentAt: { gte: since } } }),
      prisma.draft.count({ where: { workspaceId: session.wid, status: 'pending' } }),
      prisma.draft.count({ where: { workspaceId: session.wid, status: 'rejected', decidedAt: { gte: since } } }),
      prisma.comment.count({ where: { workspaceId: session.wid, createdAt: { gte: since } } }),
      prisma.message.count({ where: { workspaceId: session.wid, direction: 'inbound', createdAt: { gte: since } } }),
      prisma.draft.aggregate({ where: { workspaceId: session.wid, createdAt: { gte: since } }, _avg: { confidence: true }, _sum: { costUsd: true } }),
    ]),
  ])

  const [sent, autoSent, pending, rejected, comments, messages, agg] = totals

  return NextResponse.json({
    range: { days, since },
    totals: {
      sent,
      autoSent,
      autoRate: sent ? Number(((autoSent / sent) * 100).toFixed(1)) : 0,
      pending,
      rejected,
      approvalRate: sent + rejected ? Number(((sent / (sent + rejected)) * 100).toFixed(1)) : 0,
      comments,
      messages,
      avgConfidence: Number((agg._avg.confidence ?? 0).toFixed(3)),
      costUsd: Number((agg._sum.costUsd ?? 0).toFixed(4)),
    },
    daily: daily.map((d) => ({
      day: d.day,
      inboundComments: d.inboundComments,
      inboundMessages: d.inboundMessages,
      autoSent: d.autoSent,
      approved: d.approved,
      rejected: d.rejected,
      escalated: d.escalated,
      failed: d.failed,
      llmCalls: d.llmCalls,
      costUsd: Number(d.costUsd.toFixed(4)),
    })),
    accounts: byAccount,
    intents: intents.map((i) => ({ intent: i.intent ?? 'other', count: i._count._all })),
  })
}

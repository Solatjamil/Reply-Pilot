import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { queueStats } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const url = new URL(req.url)
  const take = Math.min(Number(url.searchParams.get('limit') ?? 100), 500)
  const type = url.searchParams.get('type')
  const level = url.searchParams.get('level')

  const [events, jobs, stats] = await Promise.all([
    prisma.eventLog.findMany({
      where: {
        workspaceId: session.wid,
        ...(type ? { type } : {}),
        ...(level ? { level } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: { account: { select: { name: true, platform: true } } },
    }),
    prisma.job.findMany({
      where: { workspaceId: session.wid },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { id: true, type: true, status: true, attempts: true, lastError: true, runAt: true, updatedAt: true, account: { select: { name: true, platform: true } } },
    }),
    queueStats(session.wid),
  ])

  return NextResponse.json({ events, jobs, queue: stats })
}

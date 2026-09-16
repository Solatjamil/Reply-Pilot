import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { DRAFT_INCLUDE, toInboxItem } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

/** JSON view of the inbox — handy for integrations and debugging. */
export async function GET(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? 'pending'
  const take = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)

  const drafts = await prisma.draft.findMany({
    where: {
      workspaceId: session.wid,
      ...(status === 'all' ? {} : { status: { in: status.split(',') } }),
    },
    orderBy: { createdAt: 'desc' },
    take,
    include: DRAFT_INCLUDE,
  })

  return NextResponse.json({ count: drafts.length, drafts: drafts.map(toInboxItem) })
}

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { getAccountRecord } from '@/lib/platforms'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params

  const account = await prisma.account.findFirst({ where: { id, workspaceId: session.wid } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  await prisma.account.delete({ where: { id } })
  await logEvent({ workspaceId: session.wid, type: 'account.disconnected', message: `Disconnected ${account.name} (${account.platform})` })
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { action?: string }
  const action = body.action ?? 'sync'

  const record = await getAccountRecord(id)
  if (!record || record.workspaceId !== session.wid) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  if (action === 'sync') {
    await enqueue({ type: 'sync_account', accountId: id, workspaceId: session.wid, payload: { accountId: id }, key: `sync:${id}:${Date.now()}`, priority: 40 })
    return NextResponse.json({ ok: true, queued: 'sync_account' })
  }

  if (action === 'retry') {
    await prisma.account.update({ where: { id }, data: { status: 'active', lastError: null, errorSince: null } })
    await prisma.job.updateMany({ where: { accountId: id, status: 'failed' }, data: { status: 'queued', attempts: 0, runAt: new Date() } })
    await prisma.draft.updateMany({ where: { accountId: id, status: 'failed' }, data: { status: 'pending', action: 'review' } })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
}

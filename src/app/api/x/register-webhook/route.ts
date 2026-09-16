import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { logEvent } from '@/lib/log'
import { getAccountRecord } from '@/lib/platforms'
import { registerXWebhook } from '@/lib/platforms/adapters/x'

export const dynamic = 'force-dynamic'

const schema = z.object({ accountId: z.string().min(1) })

/**
 * Registers the X Account Activity webhook + user subscription for a connected
 * X account. Needs a paid X tier plus X_API_KEY / X_API_KEY_SECRET.
 */
export async function POST(req: Request) {
  let session
  try {
    session = await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'accountId is required' }, { status: 400 })

  const row = await prisma.account.findFirst({ where: { id: parsed.data.accountId, workspaceId: session.wid } })
  if (!row) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  if (row.platform !== 'x') return NextResponse.json({ error: 'That account is not an X account.' }, { status: 400 })

  const account = await getAccountRecord(row.id)
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const result = await registerXWebhook(account)
  await logEvent({
    workspaceId: session.wid,
    accountId: row.id,
    type: result.ok ? 'webhook.registered' : 'webhook.register_failed',
    level: result.ok ? 'info' : 'error',
    message: result.ok ? 'X Account Activity webhook registered and subscribed' : (result.error ?? 'registration failed'),
  })

  return NextResponse.json(result.ok ? { ok: true, webhookId: result.webhookId } : { ok: false, error: result.error }, { status: result.ok ? 200 : 400 })
}

import { NextResponse } from 'next/server'
import { requireApiSession } from '@/lib/auth'
import { dispatchScheduledDrafts, schedulePolling } from '@/lib/worker/handlers'
import { drainQueue } from '@/lib/worker'
import { isServerless } from '@/lib/serverless'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual / cron trigger for the background work.
 *   POST /api/jobs/run   (authenticated, from the UI)
 *   GET  /api/jobs/run   (for cron — set CRON_SECRET and supply it either as
 *                         ?key=CRON_SECRET or, the way Vercel Cron sends it,
 *                         as `Authorization: Bearer <CRON_SECRET>`)
 */
export async function POST() {
  try {
    await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const scheduled = await schedulePolling()
  const dispatched = await dispatchScheduledDrafts()
  return NextResponse.json({ ok: true, scheduled, dispatched })
}

function cronSecretMatches(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const url = new URL(req.url)
  if (url.searchParams.get('key') === expected) return true
  const header = req.headers.get('authorization') ?? ''
  return header === `Bearer ${expected}`
}

export async function GET(req: Request) {
  if (!cronSecretMatches(req)) {
    try {
      await requireApiSession()
    } catch {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
  }

  // A serverless invocation should stop as soon as the queue is empty rather
  // than idle-spin until the deadline; a real cron box can afford to wait and
  // catch jobs that become claimable mid-run.
  const drained = await drainQueue({ maxSeconds: 25, stopWhenIdle: isServerless })
  return NextResponse.json({ ok: true, ...drained })
}

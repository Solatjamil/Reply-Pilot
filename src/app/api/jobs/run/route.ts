import { NextResponse } from 'next/server'
import { requireApiSession } from '@/lib/auth'
import { dispatchScheduledDrafts, schedulePolling } from '@/lib/worker/handlers'
import { drainQueue } from '@/lib/worker'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual / cron trigger for the background work.
 *   POST /api/jobs/run            (authenticated, from the UI)
 *   GET  /api/jobs/run?key=...    (for external cron when ENABLE_INPROC_WORKER=0,
 *                                  set CRON_SECRET in .env and use ?key=CRON_SECRET)
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

export async function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key')
  const expected = process.env.CRON_SECRET
  if (expected && key === expected) {
    const drained = await drainQueue({ maxSeconds: 25 })
    return NextResponse.json({ ok: true, ...drained })
  }
  try {
    await requireApiSession()
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const drained = await drainQueue({ maxSeconds: 25 })
  return NextResponse.json({ ok: true, ...drained })
}

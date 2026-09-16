import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { sha256 } from '@/lib/crypto'
import { tiktokAdapter } from '@/lib/platforms/adapters/tiktok'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** TikTok Business Messaging webhook (partner-gated). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const query = Object.fromEntries(url.searchParams.entries())
  const result = tiktokAdapter.verifyWebhook?.({ method: 'GET', query, rawBody: '', headers: req.headers })
  if (result?.ok && result.challenge) return new NextResponse(result.challenge, { status: 200 })
  return new NextResponse('forbidden', { status: 403 })
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  const result = tiktokAdapter.verifyWebhook?.({ method: 'POST', query: {}, rawBody, headers: req.headers })
  if (result && !result.ok) {
    await logEvent({ type: 'webhook.rejected', level: 'warn', message: `TikTok webhook rejected: ${result.message}` })
    return new NextResponse('invalid signature', { status: result.status ?? 401 })
  }

  await enqueue({
    type: 'process_webhook',
    payload: { platform: 'tiktok', rawBody, headers: Object.fromEntries(req.headers.entries()) },
    key: `tiktok:${sha256(rawBody).slice(0, 32)}`,
    priority: 30,
    maxAttempts: 3,
  })

  return NextResponse.json({ ok: true })
}

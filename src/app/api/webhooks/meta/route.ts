import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { sha256 } from '@/lib/crypto'
import { drainAfterResponse } from '@/lib/serverless'
import { metaAdapter } from '@/lib/platforms/adapters/meta'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Room for the ACK plus the post-response queue drain on serverless.
export const maxDuration = 30

/**
 * Meta webhook endpoint — handles Facebook Pages, Instagram comments/mentions
 * and Messenger + Instagram messaging in one place.
 *
 * Configure in the Meta App Dashboard → Webhooks:
 *   Callback URL : {APP_URL}/api/webhooks/meta
 *   Verify token : META_VERIFY_TOKEN
 *   Subscribe to : pages(feed), instagram(comments, mentions), messaging,
 *                  messaging_postbacks, message_echoes, comments
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const query = Object.fromEntries(url.searchParams.entries())
  const result = metaAdapter.verifyWebhook?.({ method: 'GET', query, rawBody: '', headers: req.headers })
  if (result?.ok && result.challenge) return new NextResponse(result.challenge, { status: 200 })
  return new NextResponse('forbidden', { status: 403 })
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  const result = metaAdapter.verifyWebhook?.({ method: 'POST', query: {}, rawBody, headers: req.headers })

  if (result && !result.ok) {
    await logEvent({ type: 'webhook.rejected', level: 'warn', message: `Meta webhook rejected: ${result.message}` })
    return new NextResponse('invalid signature', { status: result.status ?? 401 })
  }

  try {
    const events = metaAdapter.parseWebhook?.(rawBody, req.headers) ?? []
    await enqueue({
      type: 'process_webhook',
      payload: { platform: 'instagram', rawBody, headers: Object.fromEntries(req.headers.entries()) },
      key: `meta:${sha256(rawBody).slice(0, 32)}`,
      priority: 30,
      maxAttempts: 3,
    })
    await logEvent({
      type: 'webhook.received',
      level: 'debug',
      message: `Meta webhook accepted (${events.length} event(s))`,
    })
  } catch (err) {
    await logEvent({ type: 'webhook.error', level: 'error', message: (err as Error).message })
  }

  // Always 200 quickly — Meta retries aggressively and eventually unsubscribes.
  // Serverless has no background worker, so drain the job we just enqueued
  // once the ACK has been sent.
  drainAfterResponse()

  return NextResponse.json({ ok: true })
}

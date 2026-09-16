import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { sha256 } from '@/lib/crypto'
import { xAdapter } from '@/lib/platforms/adapters/x'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * X (Twitter) Account Activity API webhook.
 * Requires a paid X API tier + X_API_KEY / X_API_KEY_SECRET. ReplyPilot
 * registers the webhook and subscription automatically (Settings → X).
 * Without it, X ingestion runs on polling instead.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const query = Object.fromEntries(url.searchParams.entries())

  // CRC handshake — must return {"response_token":"sha256=..."} as JSON.
  if (query.crc_token) {
    const result = xAdapter.verifyWebhook?.({ method: 'GET', query, rawBody: '', headers: req.headers })
    if (result?.ok && result.challenge) {
      return new NextResponse(result.challenge, { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return NextResponse.json({ error: result?.ok === false ? result.message : 'CRC failed' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const rawBody = await req.text()

  const result = xAdapter.verifyWebhook?.({
    method: 'POST',
    query: {},
    rawBody,
    headers: req.headers,
  })
  if (result && !result.ok) {
    await logEvent({ type: 'webhook.rejected', level: 'warn', message: `X webhook rejected: ${result.message}` })
    return NextResponse.json({ error: result.message }, { status: result.status ?? 401 })
  }

  await enqueue({
    type: 'process_webhook',
    payload: { platform: 'x', rawBody, headers: Object.fromEntries(req.headers.entries()) },
    key: `x:${sha256(rawBody).slice(0, 32)}`,
    priority: 30,
    maxAttempts: 3,
  })
  await logEvent({ type: 'webhook.received', level: 'debug', message: 'X Account Activity webhook received' })

  return NextResponse.json({ ok: true })
}

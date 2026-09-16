import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/log'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * LinkedIn webhook endpoint.
 *
 * LinkedIn's Community Management API does not deliver comment events to
 * third-party apps unless you are in the relevant partner program, so
 * ReplyPilot ingests LinkedIn comments by polling instead. This endpoint
 * exists so a partner-program app can point LinkedIn at it later — payloads
 * are logged for inspection.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const challenge = url.searchParams.get('hub.challenge')
  const token = url.searchParams.get('hub.verify_token')

  // Plain health check (no handshake params) — keep this 200.
  if (!challenge && !token) return NextResponse.json({ ok: true })

  const expected = process.env.LINKEDIN_VERIFY_TOKEN || 'replypilot-linkedin-verify'
  if (challenge && token === expected) return new NextResponse(challenge, { status: 200 })
  return new NextResponse('forbidden', { status: 403 })
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  await logEvent({
    type: 'webhook.received',
    level: 'info',
    message: 'LinkedIn webhook received (comment polling is used for ingestion unless your app has partner webhook access)',
    data: { size: rawBody.length },
  })
  return NextResponse.json({ ok: true })
}

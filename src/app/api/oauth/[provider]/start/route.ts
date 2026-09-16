import { NextResponse } from 'next/server'
import { requireApiSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { encryptJson, randomToken } from '@/lib/crypto'
import { prisma } from '@/lib/db'
import { signOAuthState } from '@/lib/oauth-state'
import { logEvent } from '@/lib/log'
import { ADAPTERS } from '@/lib/platforms'

export const dynamic = 'force-dynamic'

const PROVIDER_TO_ADAPTER: Record<string, keyof typeof ADAPTERS> = {
  meta: 'meta',
  meta_ig: 'meta',
  tiktok: 'tiktok',
  google: 'youtube',
  linkedin: 'linkedin',
  x: 'x',
}

const FRIENDLY: Record<string, string> = {
  meta: 'Meta (Facebook Pages, Instagram, Messenger)',
  meta_ig: 'Instagram Login (Instagram API)',
  tiktok: 'TikTok',
  google: 'Google / YouTube',
  linkedin: 'LinkedIn',
  x: 'X (Twitter)',
}

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params

  try {
    const session = await requireApiSession()
    const adapterKey = PROVIDER_TO_ADAPTER[provider]
    if (!adapterKey) return NextResponse.json({ error: `Unknown provider "${provider}"` }, { status: 404 })

    const adapter = ADAPTERS[adapterKey]
    if (!adapter.isConfigured() || !adapter.buildAuthorizeUrl) {
      return NextResponse.redirect(
        `${env.appUrl}/settings?error=${encodeURIComponent(`${FRIENDLY[provider] ?? provider} credentials are not configured yet — add them in .env and restart the server.`)}`,
      )
    }

    const nonce = randomToken(8)
    const state = await signOAuthState({ wid: session.wid, uid: session.sub, provider, nonce })

    // Persist the pending connection so the callback can find the workspace.
    await prisma.job.create({
      data: {
        type: 'sync_account',
        workspaceId: session.wid,
        status: 'cancelled', // placeholder until profiles are chosen
        key: `oauth:${provider}:${nonce}`,
        payload: encryptJson({ provider, nonce, wid: session.wid, uid: session.sub, startedAt: Date.now() }),
        runAt: new Date(Date.now() + 10 * 60_000),
        maxAttempts: 1,
      },
    })

    const url = adapter.buildAuthorizeUrl(state)
    await logEvent({ workspaceId: session.wid, type: 'oauth.started', message: `OAuth started for ${FRIENDLY[provider] ?? provider}` })
    return NextResponse.redirect(url)
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 401) return NextResponse.redirect(`${env.appUrl}/login`)
    const message = encodeURIComponent((err as Error).message ?? 'OAuth start failed')
    return NextResponse.redirect(`${env.appUrl}/settings?error=${message}`)
  }
}

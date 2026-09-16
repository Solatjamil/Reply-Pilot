import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { encrypt, encryptJson } from '@/lib/crypto'
import { verifyOAuthState } from '@/lib/oauth-state'
import { logEvent } from '@/lib/log'
import { ADAPTERS, capabilitiesFor } from '@/lib/platforms'

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
  meta: 'Meta',
  meta_ig: 'Instagram',
  tiktok: 'TikTok',
  google: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X',
}

function failRedirect(message: string) {
  return NextResponse.redirect(`${env.appUrl}/accounts?error=${encodeURIComponent(message)}`)
}

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const url = new URL(req.url)
  const search = Object.fromEntries(url.searchParams.entries())

  const errorParam = search.error ?? search.error_description
  if (errorParam) {
    return failRedirect(`${FRIENDLY[provider] ?? provider} authorization was cancelled: ${errorParam}`)
  }

  const code = search.code
  const stateParam = search.state
  if (!code || !stateParam) return failRedirect('Missing code or state in the OAuth callback.')

  // X packs the PKCE verifier into the state: "<signed>.<verifier>"
  const signedPart = stateParam.split('.')[0]
  const verifier = stateParam.includes('.') ? stateParam.slice(stateParam.indexOf('.') + 1) : undefined

  const state = await verifyOAuthState(signedPart)
  if (!state) return failRedirect('The connection attempt expired or is invalid. Please try again.')
  if (state.provider !== provider) return failRedirect('Provider mismatch in OAuth state.')

  const adapterKey = PROVIDER_TO_ADAPTER[provider]
  const adapter = ADAPTERS[adapterKey]
  if (!adapter?.completeConnection) return failRedirect(`The ${provider} adapter cannot complete connections.`)

  const pendingKey = `oauth:${provider}:${state.nonce}`

  try {
    const { tokens, profiles } = await adapter.completeConnection({
      code,
      state: verifier ?? stateParam,
      workspaceId: state.wid,
      callbackUrl: `${env.appUrl}/api/oauth/${provider}/callback`,
      rawQuery: search,
    })

    if (!tokens.accessToken) throw new Error('The provider did not return an access token.')

    if (profiles.length === 0) {
      await logEvent({
        workspaceId: state.wid,
        type: 'oauth.no_profiles',
        level: 'warn',
        message: `${FRIENDLY[provider]} authorization succeeded but no attachable profiles were returned.`,
      })
      return failRedirect(
        `${FRIENDLY[provider] ?? provider} connected, but no pages or profiles were returned. Check that the account has a Page/Professional account and that the right permissions were granted.`,
      )
    }

    // Attach the tokens to each profile so the picker page can create accounts
    // without a second OAuth round-trip.
    const enriched = profiles.map((p) => {
      const secretKey = `${p.platform}:${p.platformUid}`
      const mergedSecrets = {
        ...(p.secrets ?? {}),
        ...(tokens.profileSecrets?.[secretKey] ?? {}),
        oauthProvider: provider,
      }
      return {
        ...p,
        secrets: mergedSecrets,
        capabilities: { ...(capabilitiesFor(p.platform) ?? {}), ...(p.capabilities ?? {}) },
      }
    })

    const pending = await prisma.job.upsert({
      where: { type_key: { type: 'sync_account', key: pendingKey } },
      create: {
        type: 'sync_account',
        workspaceId: state.wid,
        status: 'cancelled',
        key: pendingKey,
        payload: encryptJson({
          provider,
          profiles: enriched,
          tokens: {
            accessToken: encrypt(tokens.accessToken),
            refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
            idToken: tokens.idToken ? encrypt(tokens.idToken) : null,
            expiresAt: tokens.expiresAt?.toISOString() ?? null,
            scope: tokens.scope ?? null,
          },
        }),
        runAt: new Date(Date.now() + 15 * 60_000),
        maxAttempts: 1,
      },
      update: {
        payload: encryptJson({
          provider,
          profiles: enriched,
          tokens: {
            accessToken: encrypt(tokens.accessToken),
            refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
            idToken: tokens.idToken ? encrypt(tokens.idToken) : null,
            expiresAt: tokens.expiresAt?.toISOString() ?? null,
            scope: tokens.scope ?? null,
          },
        }),
        runAt: new Date(Date.now() + 15 * 60_000),
      },
    })

    await logEvent({
      workspaceId: state.wid,
      type: 'oauth.authorized',
      message: `${FRIENDLY[provider]} authorized — ${profiles.length} profile(s) available to attach.`,
      data: { profiles: profiles.map((p) => `${p.platform}:${p.name}`) },
    })

    return NextResponse.redirect(`${env.appUrl}/connect/pending?id=${pending.id}`)
  } catch (err) {
    const message = (err as Error).message ?? 'OAuth callback failed'
    await logEvent({ workspaceId: state.wid, type: 'oauth.failed', level: 'error', message })
    return failRedirect(message)
  }
}


import { env } from '@/lib/env'
import { http } from '@/lib/http'
import type { TokenBundle } from './types'

export type OAuthProviderId = 'meta' | 'meta_ig' | 'tiktok' | 'google' | 'linkedin' | 'x'

export interface OAuthConfig {
  id: OAuthProviderId
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes: string[]
  /** Extra params on the authorize URL. */
  authorizeParams?: Record<string, string>
  /** 'query' | 'basic' | 'body' */
  clientAuth?: 'basic' | 'body'
  /** Some providers (TikTok, LinkedIn) post JSON instead of form-encoded. */
  tokenRequestFormat?: 'form' | 'json'
  extraTokenParams?: Record<string, string>
}

function configs(): Record<OAuthProviderId, OAuthConfig> {
  return {
  meta: {
    id: 'meta',
    authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth',
    tokenUrl: `https://graph.facebook.com/${env.meta.version}/oauth/access_token`,
    clientId: env.meta.appId,
    clientSecret: env.meta.appSecret,
    clientAuth: 'body',
    scopes: [
      'public_profile',
      'email',
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_messaging',
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'business_management',
    ],
    authorizeParams: { auth_type: 'rerequest' },
  },
  meta_ig: {
    id: 'meta_ig',
    // "Instagram Login with Instagram API" — no Facebook Page required.
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://graph.instagram.com/access_token',
    clientId: env.meta.igClientId,
    clientSecret: env.meta.igClientSecret,
    clientAuth: 'body',
    scopes: [
      'instagram_business_basic',
      'instagram_business_manage_comments',
      'instagram_business_manage_messages',
      'instagram_business_manage_insights',
    ],
  },
  tiktok: {
    id: 'tiktok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    clientId: env.tiktok.clientKey,
    clientSecret: env.tiktok.clientSecret,
    clientAuth: 'body',
    tokenRequestFormat: 'json',
    // Comment + DM endpoints require the Business Messaging product to be
    // approved for your app; scopes below are what partners request.
    scopes: ['user.info.basic', 'video.list', 'im.message', 'im.message.business', 'video.comment'],
    authorizeParams: { response_type: 'code' },
  },
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: env.google.clientId,
    clientSecret: env.google.clientSecret,
    clientAuth: 'body',
    scopes: [
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  linkedin: {
    id: 'linkedin',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    clientId: env.linkedin.clientId,
    clientSecret: env.linkedin.clientSecret,
    clientAuth: 'body',
    scopes: ['openid', 'profile', 'email', 'w_organization_social', 'r_organization_social', 'w_member_social', 'rw_organization_admin'],
  },
  x: {
    id: 'x',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    clientId: env.x.clientId,
    clientSecret: env.x.clientSecret,
    clientAuth: 'basic',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'dm.read', 'dm.write'],
    authorizeParams: { response_type: 'code' }, // PKCE added per-request
  },
  }
}

/** Evaluated per-call so env changes (and worker startup order) are respected. */
export function oauthConfig(provider: OAuthProviderId): OAuthConfig {
  return configs()[provider]
}

export const OAUTH_PROVIDERS = ['meta', 'meta_ig', 'tiktok', 'google', 'linkedin', 'x'] as const

export function buildAuthorizeUrl(
  provider: OAuthProviderId,
  opts: { redirectUri: string; state: string; codeChallenge?: string; codeVerifier?: string },
): string {
  const cfg = oauthConfig(provider)
  const url = new URL(cfg.authorizeUrl)
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('state', opts.state)
  if (cfg.scopes.length) {
    // LinkedIn/Meta/TikTok use space-separated; Google uses space too.
    url.searchParams.set('scope', cfg.scopes.join(provider === 'meta' ? ',' : ' '))
  }
  for (const [k, v] of Object.entries(cfg.authorizeParams ?? {})) url.searchParams.set(k, v)
  if (opts.codeChallenge) {
    url.searchParams.set('code_challenge', opts.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

export async function exchangeCode(provider: OAuthProviderId, opts: { code: string; redirectUri: string; codeVerifier?: string; extra?: Record<string, string> }): Promise<TokenBundle> {
  const cfg = oauthConfig(provider)
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    ...(cfg.clientAuth === 'body' ? { client_id: cfg.clientId, client_secret: cfg.clientSecret } : {}),
    ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
    ...(cfg.extraTokenParams ?? {}),
    ...(opts.extra ?? {}),
  }

  const headers: Record<string, string> = {}
  if (cfg.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`
  }

  const body = await http<Record<string, unknown>>(cfg.tokenUrl, {
    method: 'POST',
    headers,
    ...(cfg.tokenRequestFormat === 'json' ? { json: params } : { form: params }),
    timeoutMs: 30_000,
    skipLimiter: false,
    rateScope: `oauth:${provider}`,
  })

  if (body.error) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body)}`)

  const expiresIn = Number(body.expires_in ?? body.expires_in_seconds ?? 0) || null
  return {
    accessToken: String(body.access_token ?? ''),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    idToken: body.id_token ? String(body.id_token) : null,
    expiresIn,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scope: body.scope ? String(body.scope) : null,
    raw: body,
  }
}

export async function refreshOAuthToken(
  provider: OAuthProviderId,
  refreshToken: string,
  overrides: Partial<{ clientId: string; clientSecret: string }> = {},
): Promise<TokenBundle> {
  const cfg = oauthConfig(provider)
  const clientId = overrides.clientId ?? cfg.clientId
  const clientSecret = overrides.clientSecret ?? cfg.clientSecret

  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(cfg.clientAuth === 'body' ? { client_id: clientId, client_secret: clientSecret } : {}),
  }
  const headers: Record<string, string> = {}
  if (cfg.clientAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`

  const body = await http<Record<string, unknown>>(cfg.tokenUrl, {
    method: 'POST',
    headers,
    ...(cfg.tokenRequestFormat === 'json' ? { json: params } : { form: params }),
    timeoutMs: 30_000,
    rateScope: `oauth:${provider}`,
  })

  const expiresIn = Number(body.expires_in ?? 0) || null
  return {
    accessToken: String(body.access_token ?? ''),
    refreshToken: body.refresh_token ? String(body.refresh_token) : refreshToken,
    expiresIn,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scope: body.scope ? String(body.scope) : null,
    raw: body,
  }
}

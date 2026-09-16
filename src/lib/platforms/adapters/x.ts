
import crypto from 'crypto'
import { env } from '@/lib/env'
import { safeEqual } from '@/lib/crypto'
import { ApiError, http } from '@/lib/http'
import { PLATFORMS } from '../catalog'
import { buildAuthorizeUrl, exchangeCode, refreshOAuthToken } from '../oauth'
import type {
  AccountRecord,
  ConnectableProfile,
  NormalizedComment,
  NormalizedContent,
  PlatformAdapter,
  SendResult,
  WebhookEvent,
  WebhookVerifyResult,
} from '../types'

const V2 = 'https://api.x.com/2'
const V11 = 'https://api.x.com/1.1'

/**
 * X has no "comments" API. The equivalent surface is:
 *   • mentions of the account   → GET /2/users/:id/mentions
 *   • replies to the account's own posts → GET /2/users/:id/timelines/reverse_chronological
 * Both are polled. Real-time delivery needs the Account Activity API
 * (webhooks), which is only on paid X tiers — we register it when the user
 * supplies X_API_KEY / X_API_KEY_SECRET (OAuth 1.0a user context).
 */

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

interface XTweet {
  id: string
  text?: string
  created_at?: string
  author_id?: string
  in_reply_to_user_id?: string
  conversation_id?: string
  referenced_tweets?: { type: string; id: string }[]
  lang?: string
  public_metrics?: { reply_count?: number; like_count?: number; retweet_count?: number }
  entities?: { urls?: { url: string; expanded_url?: string }[]; mentions?: { username?: string }[] }
}

interface XUser {
  id: string
  name?: string
  username?: string
  profile_image_url?: string
}

export const xAdapter: PlatformAdapter = {
  id: 'x',

  isConfigured() {
    return env.x.configured
  },

  capabilities() {
    return PLATFORMS.x.capabilities
  },

  buildAuthorizeUrl(state) {
    const { verifier, challenge } = pkce()
    // The verifier must survive the redirect — the route handler persists it
    // in the `state` record before sending the user to X.
    const url = buildAuthorizeUrl('x', { redirectUri: `${env.appUrl}/api/oauth/x/callback`, state: `${state}.${verifier}`, codeChallenge: challenge })
    return url
  },

  async completeConnection({ code, state }) {
    const verifier = state.includes('.') ? state.slice(state.lastIndexOf('.') + 1) : undefined
    const tokens = await exchangeCode('x', { code, redirectUri: `${env.appUrl}/api/oauth/x/callback`, codeVerifier: verifier })

    const me = await http<{ data?: XUser }>(`${V2}/users/me`, {
      query: { 'user.fields': 'id,name,username,profile_image_url' },
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })

    const user = me.data
    const profiles: ConnectableProfile[] = user
      ? [
          {
            platform: 'x',
            platformUid: user.id,
            name: user.name ?? `@${user.username}`,
            handle: user.username ? `@${user.username}` : null,
            avatarUrl: user.profile_image_url ?? null,
            profileUrl: user.username ? `https://x.com/${user.username}` : null,
          },
        ]
      : []

    return { tokens, profiles }
  },

  async finalizeAccount({ profile }) {
    return {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      capabilities: JSON.stringify(PLATFORMS.x.capabilities),
    }
  },

  async refreshToken(account) {
    if (!account.refreshToken) return null
    return await refreshOAuthToken('x', account.refreshToken)
  },

  // ── Account Activity API (optional, paid tiers) ──

  verifyWebhook({ query, rawBody, headers }): WebhookVerifyResult {
    // CRC handshake: X sends ?crc_token=... and expects a signed response
    // within 3 seconds.
    if (query.crc_token) {
      if (!env.x.apiKeySecret) return { ok: false, status: 500, message: 'X_API_KEY_SECRET is not configured' }
      const hmac = crypto.createHmac('sha256', env.x.apiKeySecret).update(query.crc_token).digest('base64')
      return { ok: true, challenge: JSON.stringify({ response_token: `sha256=${hmac}` }) }
    }

    // Event delivery: X signs the body with the consumer secret and sends it in
    // X-Twitter-Webhooks-Signature as `sha256=<base64>`.
    const signature = headers?.get('x-twitter-webhooks-signature')
    const secret = env.x.apiKeySecret
    if (secret) {
      if (!signature) return { ok: false, status: 401, message: 'missing X-Twitter-Webhooks-Signature' }
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('base64')}`
      if (!safeEqual(expected, signature)) return { ok: false, status: 401, message: 'invalid X webhook signature' }
      return { ok: true }
    }
    // No consumer secret configured: we cannot verify. Refuse a signature we
    // cannot check rather than trusting it, but allow plainly unsigned local
    // development traffic through with a warning.
    if (signature) {
      return {
        ok: false,
        status: 500,
        message: 'X_API_KEY_SECRET is not set, so webhook signatures cannot be verified. Set it in .env and restart.',
      }
    }
    console.warn('[x] webhook accepted WITHOUT signature verification — X_API_KEY_SECRET is not configured')
    return { ok: true }
  },

  parseWebhook(rawBody): WebhookEvent[] {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return []
    }
    const events: WebhookEvent[] = []
    const forUsers = (payload.for_user_id ?? payload.user_has_blocked) as string | undefined
    const accountUid = String(forUsers ?? '')

    // Account Activity tweet_create_events use the v1.1 shape.
    const tweetEvents = (payload.tweet_create_events ?? []) as Record<string, unknown>[]
    for (const t of tweetEvents) {
      const user = t.user as Record<string, unknown> | undefined
      const text = String(t.text ?? t.full_text ?? '')
      const ownHandle = String(user?.screen_name ?? '').toLowerCase()
      const repliedTo = ((t.in_reply_to_screen_name ?? '') as string).toLowerCase()
      const isOwn = Boolean(user?.id_str && String(user.id_str) === accountUid)
      if (isOwn) continue

      const createdAt = t.created_at ? new Date(String(t.created_at)) : new Date()
      const parentId = (t.in_reply_to_status_id_str ?? null) as string | null
      const comment: NormalizedComment = {
        platformUid: String(t.id_str ?? t.id),
        contentUid: parentId,
        parentUid: parentId,
        authorId: String(user?.id_str ?? ''),
        authorName: String(user?.name ?? ''),
        authorHandle: user?.screen_name ? `@${user.screen_name}` : null,
        authorAvatar: (user?.profile_image_url_https as string) ?? null,
        text,
        permalink: user?.screen_name ? `https://x.com/${user.screen_name}/status/${t.id_str ?? t.id}` : null,
        createdAt,
        isOwn: false,
        raw: t,
      }
      void ownHandle
      void repliedTo
      events.push({ platform: 'x', type: parentId ? 'comment' : 'mention', accountUid, comment, raw: t })
    }

    // direct_message_events (v1.1 Account Activity)
    const dmEvents = (payload.direct_message_events ?? []) as Record<string, unknown>[]
    for (const d of dmEvents) {
      if (d.type !== 'message_create') continue
      const mc = d.message_create as Record<string, unknown> | undefined
      if (!mc) continue
      const senderId = String(mc.sender_id ?? '')
      const targetId = String((mc.target as Record<string, unknown>)?.recipient_id ?? '')
      if (senderId === accountUid) continue // echo
      const text = String(((mc.message_data as Record<string, unknown>)?.text as string) ?? '')
      const created = d.created_timestamp ? new Date(Number(d.created_timestamp)) : new Date()
      const uid = String(d.id ?? `${senderId}:${created.getTime()}`)
      if (!text) continue
      events.push({
        platform: 'x',
        type: 'message',
        accountUid: targetId || accountUid,
        message: {
          platformUid: uid,
          threadUid: senderId,
          direction: 'inbound',
          text,
          senderId,
          createdAt: created,
          raw: d,
        },
        thread: { platformUid: senderId, participantId: senderId, lastMessageAt: created },
        raw: d,
      })
    }

    return events
  },

  // ── Polling ingestion ──

  async listContent(ctx) {
    const { account } = ctx
    const res = await http<{ data?: XTweet[] }>(`${V2}/users/${account.platformUid}/tweets`, {
      query: {
        'tweet.fields': 'created_at,conversation_id,public_metrics,entities',
        max_results: 20,
        exclude: 'retweets,replies',
      },
      headers: { Authorization: `Bearer ${account.accessToken}` },
      rateScope: `x:${account.platformUid}:read`,
      ratePerSec: 1,
      rateBurst: 3,
    }).catch(() => ({ data: [] }))

    return (res.data ?? []).map<NormalizedContent>((t) => ({
      platformUid: t.id,
      type: 'post',
      text: t.text ?? null,
      url: `https://x.com/i/web/status/${t.id}`,
      publishedAt: t.created_at ? new Date(t.created_at) : null,
      metrics: {
        replies: t.public_metrics?.reply_count ?? 0,
        likes: t.public_metrics?.like_count ?? 0,
        reposts: t.public_metrics?.retweet_count ?? 0,
      },
    }))
  },

  async listComments(ctx, content) {
    const { account } = ctx
    const since = ctx.since
    const sinceIso = since ? since.toISOString() : undefined
    const out: NormalizedComment[] = []
    const seen = new Set<string>()

    const push = (t: XTweet, users: Map<string, XUser>, contentUid: string | null) => {
      if (seen.has(t.id)) return
      seen.add(t.id)
      if (t.author_id === account.platformUid) return
      const author = t.author_id ? users.get(t.author_id) : undefined
      out.push({
        platformUid: t.id,
        contentUid: contentUid ?? t.conversation_id ?? null,
        parentUid: t.in_reply_to_user_id ? (t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null) : null,
        authorId: t.author_id ?? null,
        authorName: author?.name ?? null,
        authorHandle: author?.username ? `@${author.username}` : null,
        authorAvatar: author?.profile_image_url ?? null,
        text: t.text ?? '',
        permalink: author?.username ? `https://x.com/${author.username}/status/${t.id}` : null,
        createdAt: t.created_at ? new Date(t.created_at) : new Date(),
        isOwn: false,
        raw: t,
      })
    }

    // 1) Mentions timeline (replies to us + @mentions)
    try {
      const mentions = await http<{ data?: XTweet[]; includes?: { users?: XUser[] } }>(`${V2}/users/${account.platformUid}/mentions`, {
        query: {
          'tweet.fields': 'created_at,author_id,in_reply_to_user_id,conversation_id,referenced_tweets,entities',
          expansions: 'author_id',
          'user.fields': 'id,name,username,profile_image_url',
          max_results: 50,
          ...(sinceIso ? { start_time: sinceIso } : {}),
        },
        headers: { Authorization: `Bearer ${account.accessToken}` },
        rateScope: `x:${account.platformUid}:read`,
        ratePerSec: 1,
        rateBurst: 3,
      })
      const users = new Map((mentions.includes?.users ?? []).map((u) => [u.id, u]))
      for (const t of mentions.data ?? []) push(t, users, content ? content.platformUid : (t.conversation_id ?? null))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err
    }

    // 2) Replies on a specific post (when polling a known post)
    if (content) {
      try {
        const search = await http<{ data?: XTweet[]; includes?: { users?: XUser[] } }>(`${V2}/tweets/search/recent`, {
          query: {
            query: `conversation_id:${content.platformUid} -is:retweet`,
            'tweet.fields': 'created_at,author_id,in_reply_to_user_id,conversation_id,referenced_tweets',
            expansions: 'author_id',
            'user.fields': 'id,name,username,profile_image_url',
            max_results: 50,
          },
          headers: { Authorization: `Bearer ${account.accessToken}` },
          rateScope: `x:${account.platformUid}:search`,
          ratePerSec: 0.2,
          rateBurst: 2,
        })
        const users = new Map((search.includes?.users ?? []).map((u) => [u.id, u]))
        for (const t of search.data ?? []) push(t, users, content.platformUid)
      } catch {
        /* search/recent is a separate (paid) endpoint — ignore if unavailable */
      }
    }

    return out
  },

  async listThreads(ctx) {
    const { account } = ctx
    // GET /2/dm_conversations requires a Pro/Enterprise tier on most accounts.
    const res = await http<{ data?: { id: string }[] }>(`${V2}/dm_conversations`, {
      query: { 'dm_conversation.fields': 'id', max_results: 50 },
      headers: { Authorization: `Bearer ${account.accessToken}` },
      rateScope: `x:${account.platformUid}:dm`,
      ratePerSec: 0.5,
      rateBurst: 2,
    }).catch(() => null)

    if (!res?.data) return []

    const threads = []
    for (const conv of res.data.slice(0, 20)) {
      const msgs = await http<{ data?: { id: string; text?: string; sender_id?: string; created_at?: string }[] }>(
        `${V2}/dm_conversations/${conv.id}/dm_events`,
        {
          query: { 'dm_event.fields': 'id,text,sender_id,created_at,event_type', max_results: 20 },
          headers: { Authorization: `Bearer ${account.accessToken}` },
          rateScope: `x:${account.platformUid}:dm`,
          ratePerSec: 0.5,
          rateBurst: 2,
        },
      ).catch(() => ({ data: [] }))

      threads.push({
        platformUid: conv.id,
        participantId: null,
        lastMessageAt: undefined,
        messages: (msgs.data ?? []).map((m) => ({
          platformUid: m.id,
          threadUid: conv.id,
          direction: (m.sender_id === account.platformUid ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
          text: m.text ?? '',
          senderId: m.sender_id ?? null,
          createdAt: m.created_at ? new Date(m.created_at) : new Date(),
        })),
      })
    }
    return threads
  },

  // ── Sending ──

  async sendCommentReply(account, comment, text) {
    if (text.length > 280) {
      return { ok: false, error: 'Reply exceeds the 280-character X limit.', permanent: true }
    }
    try {
      const res = await http<{ data?: { id?: string } }>(`${V2}/tweets`, {
        method: 'POST',
        json: { text, reply: { in_reply_to_tweet_id: comment.platformUid } },
        headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
        rateScope: `x:${account.platformUid}:write`,
        ratePerSec: 0.5,
        rateBurst: 2,
      })
      return { ok: true, platformReplyId: res.data?.id ?? null }
    } catch (err) {
      return xError(err)
    }
  },

  async sendDm(account, thread, text) {
    try {
      // A real X dm_conversation_id looks like a long numeric string.
      if (thread.platformUid && /^\d{10,}$/.test(thread.platformUid)) {
        const res = await http<{ data?: { dm_conversation_id?: string; dm_event_id?: string } }>(
          `${V2}/dm_conversations/${thread.platformUid}/messages`,
          {
            method: 'POST',
            json: { text },
            headers: { Authorization: `Bearer ${account.accessToken}` },
            rateScope: `x:${account.platformUid}:dm`,
            ratePerSec: 0.5,
            rateBurst: 2,
          },
        )
        return { ok: true, platformReplyId: res.data?.dm_event_id ?? res.data?.dm_conversation_id ?? null }
      }
      if (thread.participantId) {
        const res = await http<{ data?: { dm_conversation_id?: string; dm_event_id?: string } }>(`${V2}/dm_conversations`, {
          method: 'POST',
          json: { conversation_type: 'Group', participant_ids: [thread.participantId], message: { text } },
          headers: { Authorization: `Bearer ${account.accessToken}` },
          rateScope: `x:${account.platformUid}:dm`,
          ratePerSec: 0.5,
          rateBurst: 2,
        })
        return { ok: true, platformReplyId: res.data?.dm_event_id ?? null }
      }
      return { ok: false, error: 'Cannot send DM: no conversation or participant id known.', permanent: true }
    } catch (err) {
      return xError(err)
    }
  },
}

function xError(err: unknown): SendResult {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: string; title?: string; errors?: { message?: string }[] } | undefined
    const msg = body?.detail ?? body?.title ?? body?.errors?.[0]?.message ?? err.message
    const permanent = err.status === 400 || err.status === 401 || err.status === 403
    return { ok: false, error: `X API error ${err.status}: ${msg}`, permanent, raw: err.body }
  }
  return { ok: false, error: `X API error: ${(err as Error).message}` }
}

// ── Optional: Account Activity webhook registration (OAuth 1.0a) ──

/**
 * Registers the Account Activity webhook and subscribes the connected user.
 * Requires X_API_KEY + X_API_KEY_SECRET (consumer keys) and a paid X tier.
 */
export async function registerXWebhook(account: AccountRecord): Promise<{ ok: boolean; error?: string; webhookId?: string }> {
  if (!env.x.apiKey || !env.x.apiKeySecret) {
    return { ok: false, error: 'X_API_KEY and X_API_KEY_SECRET are required to register Account Activity webhooks.' }
  }
  if (!account.accessToken) return { ok: false, error: 'Account has no access token.' }
  const url = `${env.appUrl}/api/webhooks/x`

  try {
    const existing = await http<{ environments?: { webhooks?: { id: string; url: string; valid: boolean }[] }[] }>(
      `${V11}/account_activity/all/webhooks.json`,
      {
        headers: { Authorization: oauth1Header('GET', `${V11}/account_activity/all/webhooks.json`, {}, account) },
      },
    ).catch(() => ({ environments: [] }))

    let webhookId = existing.environments?.[0]?.webhooks?.find((w) => w.url === url && w.valid)?.id

    if (!webhookId) {
      const created = await http<{ id?: string }>(`${V11}/account_activity/all/webhooks.json`, {
        method: 'POST',
        form: { url },
        headers: { Authorization: oauth1Header('POST', `${V11}/account_activity/all/webhooks.json`, { url }, account) },
      })
      webhookId = created.id
    }
    if (!webhookId) return { ok: false, error: 'Could not create or find an X webhook.' }

    await http<unknown>(`${V11}/account_activity/all/subscriptions.json`, {
      method: 'POST',
      headers: { Authorization: oauth1Header('POST', `${V11}/account_activity/all/subscriptions.json`, {}, account) },
    })

    return { ok: true, webhookId }
  } catch (err) {
    const msg = err instanceof ApiError ? `${err.status} ${JSON.stringify(err.body).slice(0, 300)}` : (err as Error).message
    return { ok: false, error: `X webhook registration failed: ${msg}` }
  }
}

function oauth1Header(method: string, url: string, params: Record<string, string>, account: AccountRecord): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.x.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: account.accessToken ?? '',
    oauth_version: '1.0',
  }
  const all = { ...oauth, ...params }
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(
      Object.keys(all)
        .sort()
        .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`)
        .join('&'),
    ),
  ].join('&')
  const signingKey = `${percentEncode(env.x.apiKeySecret)}&${percentEncode(account.secrets?.oauthTokenSecret ? String(account.secrets.oauthTokenSecret) : '')}`
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64')

  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
    .join(', ')}`
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export default xAdapter

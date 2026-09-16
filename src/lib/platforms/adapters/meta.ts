
import { env } from '@/lib/env'
import { ApiError, http } from '@/lib/http'
import { PLATFORMS } from '../catalog'
import { buildAuthorizeUrl, exchangeCode, oauthConfig, type OAuthProviderId } from '../oauth'
import type {
  AccountRecord,
  ConnectableProfile,
  NormalizedComment,
  NormalizedContent,
  NormalizedMessage,
  NormalizedThread,
  PlatformAdapter,
  SendResult,
  TokenBundle,
  WebhookEvent,
  WebhookVerifyResult,
} from '../types'

const graph = (version = env.meta.version) => `https://graph.facebook.com/${version}`

/** Single place that turns an AccountRecord into a working Graph token. */
function tokenFor(account: AccountRecord): string {
  // Messenger/Instagram accounts connected through Facebook Login store the
  // page token in secrets.pageAccessToken.
  const pageToken = account.secrets?.pageAccessToken as string | undefined
  return pageToken || account.accessToken || ''
}

function igLoginProvider(account: AccountRecord): OAuthProviderId {
  return account.secrets?.oauthProvider === 'meta_ig' ? 'meta_ig' : 'meta'
}

interface FbComment {
  id: string
  message?: string
  created_time?: string
  permalink_url?: string
  from?: { id?: string; name?: string; username?: string }
  like_count?: number
  comment_count?: number
  private_reply_conversation?: { id?: string }
  // Instagram comment shape (same endpoint, different field names)
  text?: string
  timestamp?: string
  username?: string
  permalink?: string
}

interface FbPost {
  id: string
  message?: string
  permalink_url?: string
  created_time?: string
  full_picture?: string
  comments?: { data?: FbComment[] }
  shares?: { count?: number }
}

export const metaAdapter: PlatformAdapter = {
  id: 'meta',

  isConfigured() {
    return env.meta.configured || env.meta.igConfigured
  },

  capabilities() {
    return PLATFORMS.facebook_page.capabilities
  },

  buildAuthorizeUrl(state: string) {
    const provider: OAuthProviderId = env.meta.configured ? 'meta' : 'meta_ig'
    return buildAuthorizeUrl(provider, {
      redirectUri: `${env.appUrl}/api/oauth/meta/callback`,
      state,
    })
  },

  async completeConnection({ code }) {
    const provider: OAuthProviderId = env.meta.configured ? 'meta' : 'meta_ig'
    const tokens = await exchangeCode(provider, {
      code,
      redirectUri: `${env.appUrl}/api/oauth/meta/callback`,
    })

    if (provider === 'meta_ig') {
      // Instagram Login with Instagram API: no page concept, one IG account.
      const me = await http<{
        user_id?: string
        username?: string
        account_id?: string
        name?: string
        profile_picture_url?: string
        user_type?: string
      }>(`${graph('v23.0')}/me`, {
        query: {
          fields: 'user_id,username,account_id,name,profile_picture_url,user_type',
          access_token: tokens.accessToken,
        },
      })

      const uid = String(me.user_id ?? me.account_id ?? '')
      const profile: ConnectableProfile = {
        platform: 'instagram',
        platformUid: uid,
        name: me.name || me.username || 'Instagram account',
        handle: me.username ? `@${me.username}` : null,
        avatarUrl: me.profile_picture_url ?? null,
        profileUrl: me.username ? `https://instagram.com/${me.username}` : null,
        warning:
          me.user_type && me.user_type !== 'BUSINESS' && me.user_type !== 'CREATOR'
            ? `This Instagram account is "${me.user_type}". Switch it to a Business or Creator account in the Instagram app, otherwise comments/DMs cannot be automated.`
            : undefined,
      }
      return { tokens, profiles: [profile] }
    }

    // Facebook Login: long-lived user token → pages → IG accounts on those pages.
    const longLived = await http<Record<string, unknown>>(`${graph()}/oauth/access_token`, {
      query: {
        grant_type: 'fb_exchange_token',
        client_id: env.meta.appId,
        client_secret: env.meta.appSecret,
        fb_exchange_token: tokens.accessToken,
      },
    })
    const userToken = String(longLived.access_token ?? tokens.accessToken)
    const expiresIn = Number(longLived.expires_in ?? 0) || null

    const accountsRes = await http<{ data?: FbPage[] }>(`${graph()}/me/accounts`, {
      query: {
        fields:
          'id,name,access_token,category,picture{url},link,fan_count,instagram_business_account{id,username,name,profile_picture_url,is_published_user,followers_count},tasks',
        limit: 100,
        access_token: userToken,
      },
    })

    const pages = accountsRes.data ?? []
    const profiles: ConnectableProfile[] = []
    const profileSecrets: Record<string, Record<string, unknown>> = {}

    for (const page of pages) {
      const pageKey = `facebook_page:${page.id}`
      profiles.push({
        platform: 'facebook_page',
        platformUid: page.id,
        name: page.name,
        handle: page.link ? `@${page.link.replace(/^https?:\/\/(www\.)?facebook\.com\//, '')}` : null,
        avatarUrl: page.picture?.data?.url ?? page.picture?.url ?? null,
        profileUrl: page.link ?? `https://facebook.com/${page.id}`,
        secrets: { pageAccessToken: page.access_token, pageId: page.id, category: page.category, oauthProvider: 'meta' },
      })
      profileSecrets[pageKey] = { pageAccessToken: page.access_token, pageId: page.id, oauthProvider: 'meta' }

      if (page.access_token) {
        profiles.push({
          platform: 'messenger',
          platformUid: page.id,
          name: `${page.name} · Messenger`,
          handle: page.link ? `@${page.link.replace(/^https?:\/\/(www\.)?facebook\.com\//, '')}` : null,
          avatarUrl: page.picture?.data?.url ?? null,
          profileUrl: page.link ?? `https://m.me/${page.id}`,
          secrets: { pageAccessToken: page.access_token, pageId: page.id, oauthProvider: 'meta' },
        })
        profileSecrets[`messenger:${page.id}`] = { pageAccessToken: page.access_token, pageId: page.id, oauthProvider: 'meta' }
      }

      const ig = page.instagram_business_account
      if (ig?.id) {
        profiles.push({
          platform: 'instagram',
          platformUid: String(ig.id),
          name: ig.name || (ig.username ? `@${ig.username}` : 'Instagram'),
          handle: ig.username ? `@${ig.username}` : null,
          avatarUrl: ig.profile_picture_url ?? page.picture?.data?.url ?? null,
          profileUrl: ig.username ? `https://instagram.com/${ig.username}` : null,
          secrets: {
            pageAccessToken: page.access_token,
            pageId: page.id,
            igUsername: ig.username,
            oauthProvider: 'meta',
          },
          warning: ig.is_published_user === false ? 'This Instagram profile is private — API access is limited.' : undefined,
        })
        profileSecrets[`instagram:${ig.id}`] = {
          pageAccessToken: page.access_token,
          pageId: page.id,
          igUsername: ig.username,
          oauthProvider: 'meta',
        }
      }
    }

    const bundle: TokenBundle = {
      accessToken: userToken,
      refreshToken: null,
      expiresIn,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      scope: String(longLived.scope ?? tokens.scope ?? ''),
      raw: { ...tokens.raw, long_lived: longLived },
      profileSecrets,
    }

    return { tokens: bundle, profiles }
  },

  async finalizeAccount({ profile }) {
    return {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      regionCode: null,
      capabilities: JSON.stringify(
        profile.platform === 'messenger'
          ? PLATFORMS.messenger.capabilities
          : profile.platform === 'instagram'
            ? PLATFORMS.instagram.capabilities
            : PLATFORMS.facebook_page.capabilities,
      ),
    }
  },

  async refreshToken(account) {
    const provider = igLoginProvider(account)
    if (provider === 'meta_ig') {
      // Instagram Login tokens are short-lived (~24h) and refreshable for 60 days.
      const res = await http<Record<string, unknown>>('https://graph.instagram.com/refresh_access_token', {
        query: { grant_type: 'ig_refresh_token', access_token: account.accessToken ?? '' },
      })
      if (!res.access_token) return null
      const expiresIn = Number(res.expires_in ?? 0) || null
      return {
        accessToken: String(res.access_token),
        expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        raw: res,
      }
    }
    // Facebook Login: page tokens derived from a long-lived user token do not
    // expire. If a refresh token exists we still try it.
    if (!account.refreshToken) return null
    return null
  },

  verifyWebhook({ method, query, rawBody, headers }): WebhookVerifyResult {
    if (method === 'GET') {
      const mode = query['hub.mode']
      const token = query['hub.verify_token']
      const challenge = query['hub.challenge']
      if (mode === 'subscribe' && token === env.meta.verifyToken) return { ok: true, challenge }
      return { ok: false, status: 403, message: 'verify token mismatch' }
    }

    const signature = headers.get('x-hub-signature-256')
    const secret = env.meta.appSecret
    if (secret) {
      if (!signature) return { ok: false, status: 401, message: 'missing X-Hub-Signature-256' }
      const expected = `sha256=${hmac(rawBody, secret)}`
      if (expected !== signature) return { ok: false, status: 401, message: 'invalid X-Hub-Signature-256' }
      return { ok: true }
    }
    // No app secret configured (local development). If Meta did send a signature
    // we can't validate it, so say so loudly instead of silently trusting it.
    if (signature) {
      return { ok: false, status: 500, message: 'META_APP_SECRET is not set, so webhook signatures cannot be verified. Set it in .env and restart.' }
    }
    console.warn('[meta] webhook accepted WITHOUT signature verification — META_APP_SECRET is not configured')
    return { ok: true }
  },

  parseWebhook(rawBody): WebhookEvent[] {
    const events: WebhookEvent[] = []
    let payload: MetaWebhookPayload
    try {
      payload = JSON.parse(rawBody) as MetaWebhookPayload
    } catch {
      return events
    }

    for (const entry of payload.entry ?? []) {
      const pageId = entry.id
      const time = entry.time ? new Date(entry.time * 1000) : new Date()

      // ── Page feed changes (comments, mentions, ratings) ──
      for (const change of entry.changes ?? []) {
        if (change.field !== 'feed' && change.field !== 'comments' && change.field !== 'mentions') continue
        const v = change.value as MetaChangeValue | undefined
        if (!v) continue
        const verb = String(v.verb ?? '')
        const itemType = String(v.item ?? '')

        if (verb === 'add' && (itemType === 'comment' || itemType === 'post' || change.field === 'mentions')) {
          const commentId = String(v.comment_id ?? v.post_id ?? '')
          if (!commentId) continue
          events.push({
            platform: 'facebook_page',
            type: itemType === 'post' && change.field === 'mentions' ? 'mention' : 'comment',
            accountUid: pageId,
            comment: {
              platformUid: commentId,
              contentUid: String(v.post_id ?? '').split('_')[0] || null,
              parentUid: null,
              authorId: v.from?.id ? String(v.from.id) : null,
              authorName: v.from?.name ? String(v.from.name) : null,
              text: String(v.message ?? ''),
              permalink: v.link ? String(v.link) : null,
              createdAt: v.created_time ? new Date(Number(v.created_time) * 1000) : time,
              isOwn: false,
              raw: v,
            },
            raw: change,
          })
        }
      }

      // ── Instagram comment / mention webhooks ──
      for (const change of entry.changes ?? []) {
        if (change.field !== 'comments' && change.field !== 'mentions') continue
        const v = change.value as MetaChangeValue
        const mediaId = v.media?.id ? String(v.media.id) : ''
        const commentId = String(v.id ?? v.comment_id ?? '')
        if (!commentId) continue
        const igUid = entry.instagram_user_id ? String(entry.instagram_user_id) : String(v.ig_id ?? pageId)
        events.push({
          platform: 'instagram',
          type: change.field === 'mentions' ? 'mention' : 'comment',
          accountUid: igUid,
          comment: {
            platformUid: commentId,
            contentUid: mediaId || null,
            parentUid: v.parent_id ? String(v.parent_id) : null,
            authorId: v.from?.id ? String(v.from.id) : null,
            authorName: v.from?.username ? String(v.from.username) : null,
            authorHandle: v.from?.username ? String(v.from.username) : null,
            text: String(v.text ?? v.message ?? ''),
            permalink: v.permalink ? String(v.permalink) : null,
            createdAt: v.timestamp ? new Date(Number(v.timestamp)) : time,
            isOwn: false,
            raw: v,
          },
          raw: change,
        })
      }

      // ── Messenger + Instagram messaging ──
      for (const m of entry.messaging ?? []) {
        const isInbound = Boolean(m.message && !m.message.is_echo)
        const isEcho = Boolean(m.message?.is_echo)
        if (!isInbound && !isEcho) continue
        const senderId = m.sender?.id ? String(m.sender.id) : ''
        const recipientId = m.recipient?.id ? String(m.recipient.id) : ''
        const isInstagram =
          Boolean((m as unknown as Record<string, unknown>).is_instagram) ||
          payload.object === 'instagram' ||
          Boolean(entry.instagram_user_id)
        const text = extractMessageText(m.message)
        const commentId = m.message?.reply_to?.mid ? undefined : (m.postback?.ref ? String(m.postback.ref) : undefined)
        const platform: 'messenger' | 'instagram' = isInstagram ? 'instagram' : 'messenger'
        // Messenger accounts are stored under the Facebook Page id; Instagram
        // DMs land on the IG professional account id.
        const accountUid = platform === 'instagram' ? String(entry.instagram_user_id ?? recipientId ?? pageId) : pageId

        const normalized: NormalizedMessage = {
          platformUid: String(m.message?.mid ?? `${accountUid}:${senderId}:${m.timestamp ?? Date.now()}`),
          threadUid: String(m.message?.reply_to?.mid ? senderId : senderId) || 'unknown',
          direction: isInbound ? 'inbound' : 'outbound',
          text,
          senderId,
          senderName: null,
          attachments: (m.message?.attachments ?? []) as unknown[],
          createdAt: m.timestamp ? new Date(m.timestamp) : time,
          commentUid: commentId ?? null,
          raw: m,
        }
        if (!text && !(m.message?.attachments?.length ?? 0)) continue

        events.push({
          platform,
          type: 'message',
          accountUid,
          message: normalized,
          thread: {
            platformUid: isInbound ? senderId : recipientId,
            participantId: isInbound ? senderId : recipientId,
            lastMessageAt: normalized.createdAt,
          },
          raw: m,
        })
        if (isEcho) continue
      }
    }

    return events
  },

  // ─────────────────────────── Polling ingestion ──────────────────────────

  async listContent(ctx) {
    const { account } = ctx
    const token = tokenFor(account)
    if (!token) return []

    if (account.platform === 'instagram') {
      const res = await http<{ data?: IgMedia[] }>(`${graph()}/${account.platformUid}/media`, {
        query: {
          fields: 'id,caption,permalink,media_type,media_url,thumbnail_url,timestamp,comments_count,like_count',
          limit: 25,
          access_token: token,
        },
        rateScope: `meta:${account.platformUid}:read`,
        ratePerSec: 4,
      })
      return (res.data ?? []).map(toContent)
    }

    if (account.platform === 'facebook_page') {
      const res = await http<{ data?: FbPost[] }>(`${graph()}/${account.platformUid}/feed`, {
        query: {
          fields: 'id,message,permalink_url,created_time,full_picture,shares',
          limit: 25,
          access_token: token,
        },
        rateScope: `meta:${account.platformUid}:read`,
        ratePerSec: 4,
      })
      return (res.data ?? []).map(toContent)
    }

    return []
  },

  async listComments(ctx, content) {
    const { account } = ctx
    const token = tokenFor(account)
    if (!token || !content) return []
    const ownIds = new Set([account.platformUid, String(account.secrets?.pageId ?? '')].filter(Boolean))
    const since = ctx.since?.getTime() ?? 0
    const out: NormalizedComment[] = []

    const fields =
      account.platform === 'instagram'
        ? 'id,text,timestamp,username,like_count,permalink'
        : 'id,message,created_time,from,permalink_url,like_count,comment_count'

    const res = await http<{ data?: FbComment[]; paging?: { next?: string } }>(`${graph()}/${content.platformUid}/comments`, {
      query: { fields, limit: 100, order: 'reverse_chronological', access_token: token },
      rateScope: `meta:${account.platformUid}:read`,
      ratePerSec: 4,
    })

    for (const c of res.data ?? []) {
      const created = c.timestamp ? new Date(String(c.timestamp)) : c.created_time ? new Date(c.created_time) : new Date()
      const normalized: NormalizedComment = {
        platformUid: c.id,
        contentUid: content.platformUid,
        parentUid: null,
        authorId: c.from?.id ?? null,
        authorName: account.platform === 'instagram' ? c.username ?? null : c.from?.name ?? null,
        authorHandle: c.username ?? c.from?.username ?? null,
        text: c.text ?? c.message ?? '',
        permalink: c.permalink ?? c.permalink_url ?? content.url ?? null,
        createdAt: created,
        isOwn: Boolean(c.from?.id && ownIds.has(String(c.from.id))),
        raw: c,
      }
      if (!normalized.text.trim()) continue
      if (since && created.getTime() <= since) continue
      out.push(normalized)
    }
    return out
  },

  async listThreads(ctx, opts) {
    const { account } = ctx
    const token = tokenFor(account)
    if (!token) return []
    if (account.platform !== 'messenger' && account.platform !== 'facebook_page' && account.platform !== 'instagram') return []

    const base = account.platform === 'instagram' ? account.platformUid : account.platformUid
    const limit = Math.min(opts?.limit ?? 20, 50)

    const res = await http<{ data?: FbConversation[] }>(`${graph()}/${base}/conversations`, {
      query: {
        fields: `id,updated_time,participants,message_count`,
        limit,
        access_token: token,
      },
      rateScope: `meta:${account.platformUid}:conversations`,
      ratePerSec: 2,
      rateBurst: 4,
    })

    const threads: NormalizedThread[] = []
    for (const conv of res.data ?? []) {
      const messagesRes = await http<{ data?: FbMessage[] }>(`${graph()}/${conv.id}/messages`, {
        query: { fields: 'id,message,created_time,from,attachments', limit: 20, access_token: token },
        rateScope: `meta:${account.platformUid}:conversations`,
        ratePerSec: 2,
        rateBurst: 4,
      }).catch(() => ({ data: [] }))

      const participant = (conv.participants?.data ?? []).find((p) => p.id !== account.platformUid && p.id !== String(account.secrets?.pageId ?? ''))
      threads.push({
        platformUid: conv.id,
        participantId: participant?.id ?? null,
        participantName: participant?.name ?? null,
        lastMessageAt: conv.updated_time ? new Date(conv.updated_time) : undefined,
        messages: (messagesRes.data ?? []).map((m) => ({
          platformUid: m.id,
          threadUid: conv.id,
          direction: m.from?.id === account.platformUid || m.from?.id === String(account.secrets?.pageId ?? '') ? 'outbound' : 'inbound',
          text: m.message ?? '',
          senderId: m.from?.id ?? null,
          senderName: m.from?.name ?? null,
          attachments: (m.attachments?.data ?? []) as unknown[],
          createdAt: m.created_time ? new Date(m.created_time) : new Date(),
        })),
      })
    }
    return threads
  },

  // ─────────────────────────────── Sending ────────────────────────────────

  async sendCommentReply(account, comment, text) {
    const token = tokenFor(account)
    if (!token) return fail('No access token for this Meta account — reconnect it.', true)
    try {
      if (account.platform === 'instagram') {
        const res = await http<{ id?: string }>(`${graph()}/${comment.platformUid}/replies`, {
          method: 'POST',
          form: { message: text, access_token: token },
          rateScope: `meta:${account.platformUid}:write`,
          ratePerSec: 6,
          rateBurst: 10,
        })
        return ok(res.id)
      }
      const res = await http<{ id?: string }>(`${graph()}/${comment.platformUid}/comments`, {
        method: 'POST',
        form: { message: text, access_token: token },
        rateScope: `meta:${account.platformUid}:write`,
        ratePerSec: 6,
        rateBurst: 10,
      })
      return ok(res.id)
    } catch (err) {
      return fromError(err, account.platform === 'instagram' ? 'IG comment reply' : 'FB comment reply')
    }
  },

  async sendPrivateReply(account, comment, text) {
    const token = tokenFor(account)
    if (!token) return fail('No access token for this Meta account — reconnect it.', true)
    const pageId = String(account.secrets?.pageId ?? account.platformUid)
    try {
      if (account.platform === 'instagram') {
        // IG private reply: message the commenter, referencing their comment.
        const res = await http<{ message_id?: string }>(`${graph()}/${account.platformUid}/messages`, {
          method: 'POST',
          json: { recipient: { comment_id: comment.platformUid }, message: { text } },
          headers: { Authorization: `Bearer ${token}` },
          rateScope: `meta:${account.platformUid}:private_reply`,
          ratePerSec: 0.2, // ~750/hour cap
          rateBurst: 3,
        })
        return ok(res.message_id)
      }
      const res = await http<{ recipient_id?: string; message_id?: string }>(`${graph()}/${pageId}/messages`, {
        method: 'POST',
        json: { recipient: { comment_id: comment.platformUid }, message: { text } },
        headers: { Authorization: `Bearer ${token}` },
        rateScope: `meta:${account.platformUid}:private_reply`,
        ratePerSec: 0.2,
        rateBurst: 3,
      })
      return ok(res.message_id)
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      // Meta only allows ONE private reply per comment (subcode 2534014) and a
      // 7-day window — both are permanent failures, not retryable.
      const sub = extractSubcode(apiErr?.body)
      if (sub === 2534014) return { ...fail('Meta allows only one private reply per comment.'), permanent: true }
      return fromError(err, 'private reply', sub === 100 || sub === 200 ? true : undefined)
    }
  },

  async sendDm(account, thread, text) {
    const token = tokenFor(account)
    if (!token) return fail('No access token for this Meta account — reconnect it.', true)
    const recipientId = thread.participantId
    if (!recipientId) return { ...fail('Unknown DM recipient — the participant id is missing.'), permanent: true }
    const base = account.platform === 'instagram' ? account.platformUid : String(account.secrets?.pageId ?? account.platformUid)
    try {
      const res = await http<{ recipient_id?: string; message_id?: string }>(`${graph()}/${base}/messages`, {
        method: 'POST',
        json: { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
        headers: { Authorization: `Bearer ${token}` },
        rateScope: `meta:${account.platformUid}:dm`,
        ratePerSec: 10,
        rateBurst: 20,
      })
      return ok(res.message_id ?? res.recipient_id)
    } catch (err) {
      // 551 / subcode 131026 = person not available / outside 24h window.
      const sub = extractSubcode(err instanceof ApiError ? err.body : undefined)
      const permanent = sub === 131026 || sub === 131047 || sub === 551
      return fromError(err, 'DM send', permanent)
    }
  },
}

// ─────────────────────────────── helpers ───────────────────────────────

interface FbPage {
  id: string
  name: string
  access_token?: string
  category?: string
  link?: string
  fan_count?: number
  picture?: { data?: { url?: string }; url?: string }
  instagram_business_account?: {
    id: string
    username?: string
    name?: string
    profile_picture_url?: string
    is_published_user?: boolean
    followers_count?: number
  } | null
}

interface IgMedia {
  id: string
  caption?: string
  permalink?: string
  media_type?: string
  media_url?: string
  thumbnail_url?: string
  timestamp?: string
  comments_count?: number
  like_count?: number
}

interface FbConversation {
  id: string
  updated_time?: string
  message_count?: number
  participants?: { data?: { id: string; name?: string }[] }
}

interface FbMessage {
  id: string
  message?: string
  created_time?: string
  from?: { id?: string; name?: string }
  attachments?: { data?: unknown[] }
}

interface MetaChangeValue {
  verb?: string
  item?: string
  post_id?: string
  comment_id?: string
  message?: string
  created_time?: string | number
  link?: string
  from?: { id?: string; name?: string; username?: string }
  // Instagram comments field
  id?: string
  text?: string
  timestamp?: string | number
  permalink?: string
  parent_id?: string
  media?: { id?: string }
  ig_id?: string
}

interface MetaWebhookPayload {
  object?: string
  entry?: {
    id: string
    time?: number
    instagram_user_id?: string
    messaging?: {
      sender?: { id?: string }
      recipient?: { id?: string }
      timestamp?: number
      message?: {
        mid?: string
        text?: string
        is_echo?: boolean
        attachments?: unknown[]
        reply_to?: { mid?: string }
      }
      postback?: { payload?: string; ref?: string }
    }[]
    changes?: { field: string; value: unknown }[]
  }[]
}

function toContent(p: FbPost | IgMedia): NormalizedContent {
  if ('caption' in p || 'media_type' in p) {
    const m = p as IgMedia
    return {
      platformUid: m.id,
      type: (m.media_type ?? 'post').toLowerCase(),
      text: m.caption ?? null,
      url: m.permalink ?? null,
      thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
      publishedAt: m.timestamp ? new Date(m.timestamp) : null,
      metrics: { comments: m.comments_count ?? 0, likes: m.like_count ?? 0 },
    }
  }
  const f = p as FbPost
  return {
    platformUid: f.id,
    type: 'post',
    text: f.message ?? null,
    url: f.permalink_url ?? null,
    thumbnailUrl: f.full_picture ?? null,
    publishedAt: f.created_time ? new Date(f.created_time) : null,
    metrics: { shares: f.shares?.count ?? 0 },
  }
}

interface MetaWebhookMessage {
  mid?: string
  text?: string
  is_echo?: boolean
  attachments?: unknown[]
  reply_to?: { mid?: string }
}

function extractMessageText(m?: MetaWebhookMessage): string {
  if (!m) return ''
  if (m.text) return String(m.text)
  const att = (m.attachments ?? [])[0] as { type?: string; payload?: { url?: string } } | undefined
  if (att) return `[${att.type ?? 'attachment'}]${att.payload?.url ? ` ${att.payload.url}` : ''}`
  return ''
}

function hmac(data: string, secret: string): string {
  // Imported lazily to keep this module importable in edge contexts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex')
}

function ok(id?: string | null): SendResult {
  return { ok: true, platformReplyId: id ?? null }
}
function fail(error: string, permanent = false): SendResult {
  return { ok: false, error, permanent }
}

function extractSubcode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const err = (body as { error?: { error_subcode?: number; code?: number } }).error
  return err?.error_subcode ?? err?.code
}

function fromError(err: unknown, what: string, permanent?: boolean): SendResult {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { message?: string; code?: number; error_subcode?: number } } | undefined
    const msg = body?.error?.message ?? err.message
    // 190 = invalid/expired token → reconnect needed (permanent for retries).
    const code = body?.error?.code
    const perm = permanent ?? (code === 190 || code === 10 || code === 200)
    return { ok: false, error: `Meta ${what} failed: ${msg}`, permanent: perm, raw: err.body }
  }
  return { ok: false, error: `Meta ${what} failed: ${(err as Error).message}` }
}

export default metaAdapter
export { oauthConfig }

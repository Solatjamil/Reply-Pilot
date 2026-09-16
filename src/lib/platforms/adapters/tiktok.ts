
import crypto from 'crypto'
import { env } from '@/lib/env'
import { ApiError, http } from '@/lib/http'
import { PLATFORMS } from '../catalog'
import { buildAuthorizeUrl, exchangeCode, refreshOAuthToken } from '../oauth'
import type {
  ConnectableProfile,
  NormalizedComment,
  NormalizedContent,
  NormalizedMessage,
  NormalizedThread,
  PlatformAdapter,
  PollContext,
  SendResult,
  WebhookEvent,
  WebhookVerifyResult,
} from '../types'

/**
 * TikTok.
 *
 * IMPORTANT — read docs/PLATFORM-API-REFERENCE.md#tiktok before shipping this.
 *
 * TikTok's public developer APIs (Display API / Content Posting API) expose NO
 * comment read, comment reply or DM endpoints. Those live in the **Business
 * Messaging API**, which is:
 *   • partner-gated (Open Beta, granted per app by TikTok)
 *   • restricted to TikTok **Business Accounts** linked to TikTok for Business
 *     / Business Center (this is what grants "Advanced Access")
 *   • unavailable for accounts registered in the EEA, Switzerland, the UK and
 *     India; businesses cannot initiate DMs (48h / 10-message reply window)
 *
 * This adapter therefore works in two modes:
 *
 *   1. DISPLAY MODE (default, always works): OAuth connect, read the account's
 *      videos + comment counts so you can see activity, and surface a clear
 *      "access not granted" state for replies/DMs.
 *   2. BUSINESS MESSAGING MODE: set TIKTOK_BUSINESS_MESSAGING=1 once TikTok has
 *      approved your app. Endpoints are read from env so they track whatever
 *      your partner documentation specifies:
 *        TIKTOK_BM_BASE          (default https://open.tiktokapis.com)
 *        TIKTOK_BM_COMMENT_LIST  (default /v2/im/comment/list/)
 *        TIKTOK_BM_COMMENT_REPLY (default /v2/im/comment/reply/)
 *        TIKTOK_BM_DM_LIST       (default /v2/im/message/list/)
 *        TIKTOK_BM_DM_SEND       (default /v2/im/message/send/)
 */

const OPEN = 'https://open.tiktokapis.com'

function bmEnabled(): boolean {
  return process.env.TIKTOK_BUSINESS_MESSAGING === '1'
}

const BM = {
  get base() {
    return (process.env.TIKTOK_BM_BASE || OPEN).replace(/\/$/, '')
  },
  get commentList() {
    return process.env.TIKTOK_BM_COMMENT_LIST || '/v2/im/comment/list/'
  },
  get commentReply() {
    return process.env.TIKTOK_BM_COMMENT_REPLY || '/v2/im/comment/reply/'
  },
  get dmList() {
    return process.env.TIKTOK_BM_DM_LIST || '/v2/im/message/list/'
  },
  get dmSend() {
    return process.env.TIKTOK_BM_DM_SEND || '/v2/im/message/send/'
  },
}

const NOT_GRANTED =
  'TikTok comment/DM automation requires Business Messaging API access. ' +
  'Your TikTok app must be approved by TikTok, and the account must be a TikTok Business Account linked to TikTok for Business (Advanced Access). ' +
  'DM automation is also blocked for accounts registered in the EEA, Switzerland, the UK and India. ' +
  'See Settings → Platform access for the exact steps.'

interface TikTokUserInfo {
  open_id?: string
  union_id?: string
  avatar_url?: string
  avatar_url_100?: string
  display_name?: string
  follower_count?: number
  username?: string
  bio_description?: string
  profile_deep_link?: string
}

interface TikTokVideo {
  id?: string
  video_id?: string
  title?: string
  cover_image_url?: string
  share_url?: string
  create_time?: number
  comment_count?: number
  like_count?: number
  view_count?: number
}

export const tiktokAdapter: PlatformAdapter = {
  id: 'tiktok',

  isConfigured() {
    return env.tiktok.configured
  },

  capabilities() {
    if (!bmEnabled()) return PLATFORMS.tiktok.capabilities
    return {
      ...PLATFORMS.tiktok.capabilities,
      readComments: true,
      replyToComment: true,
      readDms: true,
      sendDm: true,
      notes: [
        'Business Messaging mode enabled. Businesses cannot initiate DMs — replies only, inside a 48h / 10-message window.',
        'DM automation is unavailable for accounts registered in the EEA, Switzerland, the UK and India.',
      ],
    }
  },

  buildAuthorizeUrl(state) {
    return buildAuthorizeUrl('tiktok', { redirectUri: `${env.appUrl}/api/oauth/tiktok/callback`, state })
  },

  async completeConnection({ code }) {
    const tokens = await exchangeCode('tiktok', { code, redirectUri: `${env.appUrl}/api/oauth/tiktok/callback` })

    const info = await http<{ data?: { user?: TikTokUserInfo }; error?: { code?: string; message?: string } }>(
      `${OPEN}/v2/user/info/`,
      {
        method: 'POST',
        query: { fields: 'open_id,union_id,avatar_url,avatar_url_100,display_name,follower_count,username,bio_description,profile_deep_link' },
        json: {},
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      },
    )

    const user = info.data?.user
    if (!user?.open_id) {
      return { tokens, profiles: [] }
    }

    const profile: ConnectableProfile = {
      platform: 'tiktok',
      platformUid: user.open_id,
      name: user.display_name || user.username || 'TikTok account',
      handle: user.username ? `@${user.username}` : null,
      avatarUrl: user.avatar_url_100 || user.avatar_url || null,
      profileUrl: user.profile_deep_link || (user.username ? `https://www.tiktok.com/@${user.username}` : null),
      secrets: { openId: user.open_id, unionId: user.union_id ?? null },
      warning: bmEnabled() ? undefined : NOT_GRANTED,
    }

    return { tokens, profiles: [profile] }
  },

  async finalizeAccount({ profile }) {
    const caps = bmEnabled() ? tiktokAdapter.capabilities() : PLATFORMS.tiktok.capabilities
    return {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      status: bmEnabled() ? 'active' : 'pending_access',
      capabilities: JSON.stringify(caps),
    }
  },

  async refreshToken(account) {
    if (!account.refreshToken) return null
    return await refreshOAuthToken('tiktok', account.refreshToken)
  },

  verifyWebhook({ query, rawBody, headers }): WebhookVerifyResult {
    if (query.echostr) {
      // TikTok verification handshake
      if (query.token === env.tiktok.verifyToken) return { ok: true, challenge: query.echostr }
      return { ok: false, status: 403, message: 'verify token mismatch' }
    }
    const signature = headers.get('x-tt-signature') || headers.get('x-hub-signature-256')
    if (signature && env.tiktok.clientSecret) {
      const expected = crypto.createHmac('sha256', env.tiktok.clientSecret).update(rawBody).digest('hex')
      const provided = signature.replace(/^sha256=/, '')
      if (provided !== expected) return { ok: false, status: 401, message: 'invalid TikTok webhook signature' }
    }
    return { ok: true }
  },

  parseWebhook(rawBody): WebhookEvent[] {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return []
    }
    const events: WebhookEvent[] = []
    const accountUid = String((body.open_id ?? body.user_open_id ?? body.creator_open_id ?? '') as string)
    if (!accountUid) return events

    // Business Messaging comment events
    const comment = body.comment as Record<string, unknown> | undefined
    if (comment) {
      events.push({
        platform: 'tiktok',
        type: 'comment',
        accountUid,
        comment: toComment(comment, accountUid),
        raw: body,
      })
    }

    // Business Messaging DM events
    const message = (body.message ?? body.im_message) as Record<string, unknown> | undefined
    if (message) {
      const normalized = toMessage(message, accountUid)
      if (normalized) {
        events.push({
          platform: 'tiktok',
          type: 'message',
          accountUid,
          message: normalized,
          thread: {
            platformUid: String(message.conversation_id ?? message.conversation_short_id ?? normalized.senderId ?? 'unknown'),
            participantId: normalized.senderId ?? null,
            lastMessageAt: normalized.createdAt,
          },
          raw: body,
        })
      }
    }

    return events
  },

  async listContent(ctx: PollContext): Promise<NormalizedContent[]> {
    const { account } = ctx
    // Display API video list — available to any approved TikTok app.
    const res = await http<{
      data?: { videos?: TikTokVideo[]; cursor?: number; has_more?: boolean }
      error?: { code?: string; message?: string }
    }>(`${OPEN}/v2/video/list/`, {
      method: 'POST',
      query: { fields: 'id,title,cover_image_url,share_url,create_time,comment_count,like_count,view_count' },
      json: { max_count: 20, cursor: 0 },
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      rateScope: `tiktok:${account.platformUid}:read`,
      ratePerSec: 2,
    }).catch((err) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err
      return { data: { videos: [] } }
    })

    return (res.data?.videos ?? []).map<NormalizedContent>((v) => ({
      platformUid: String(v.id ?? v.video_id ?? ''),
      type: 'video',
      text: v.title ?? null,
      url: v.share_url ?? (account.handle ? `https://www.tiktok.com/${account.handle}/video/${v.id}` : null),
      thumbnailUrl: v.cover_image_url ?? null,
      publishedAt: v.create_time ? new Date(v.create_time * 1000) : null,
      metrics: { comments: v.comment_count ?? 0, likes: v.like_count ?? 0, views: v.view_count ?? 0 },
    }))
  },

  async listComments(ctx, content): Promise<NormalizedComment[]> {
    const { account } = ctx
    if (!bmEnabled()) return []
    if (!content) return []
    const res = await http<{ data?: { comments?: Record<string, unknown>[]; cursor?: number; has_more?: boolean } }>(
      `${BM.base}${BM.commentList}`,
      {
        method: 'POST',
        query: { fields: 'comment_id,text,create_time,like_count,reply_count,parent_comment_id,video_id' },
        json: { video_id: Number(content.platformUid), max_count: 50, cursor: 0 },
        headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        rateScope: `tiktok:${account.platformUid}:read`,
        ratePerSec: 2,
      },
    ).catch(() => ({ data: { comments: [] } }))

    const since = ctx.since?.getTime() ?? 0
    return (res.data?.comments ?? [])
      .map((c) => toComment(c, account.platformUid, content.platformUid))
      .filter((c) => c.text.trim() && (!since || c.createdAt.getTime() > since))
  },

  async listThreads(ctx): Promise<NormalizedThread[]> {
    const { account } = ctx
    if (!bmEnabled()) return []
    const res = await http<{ data?: { conversations?: Record<string, unknown>[] } }>(`${BM.base}${BM.dmList}`, {
      method: 'POST',
      json: { max_count: 20, cursor: 0 },
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      rateScope: `tiktok:${account.platformUid}:dm`,
      ratePerSec: 1,
    }).catch(() => ({ data: { conversations: [] } }))

    const out: NormalizedThread[] = []
    for (const conv of res.data?.conversations ?? []) {
      const messages = (conv.messages as Record<string, unknown>[] | undefined) ?? []
      const participantId = String(conv.peer_open_id ?? conv.participant_open_id ?? '')
      out.push({
        platformUid: String(conv.conversation_id ?? conv.conversation_short_id ?? participantId),
        participantId: participantId || null,
        participantName: (conv.peer_name as string) ?? null,
        lastMessageAt: conv.last_message_time ? new Date(Number(conv.last_message_time) * 1000) : undefined,
        messages: messages.map((m) => toMessage(m, account.platformUid)).filter(Boolean) as NormalizedMessage[],
      })
    }
    return out
  },

  async sendCommentReply(account, comment, text): Promise<SendResult> {
    if (!bmEnabled()) return { ok: false, permanent: true, error: NOT_GRANTED }
    if (text.length > 150) return { ok: false, permanent: true, error: 'TikTok comment replies are limited to ~150 characters.' }
    try {
      const res = await http<{ data?: { comment_id?: string }; error?: { code?: string; message?: string } }>(
        `${BM.base}${BM.commentReply}`,
        {
          method: 'POST',
          json: { comment_id: Number(comment.platformUid), text },
          headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
          rateScope: `tiktok:${account.platformUid}:write`,
          ratePerSec: 1,
          rateBurst: 3,
        },
      )
      if (res.error && res.error.code !== 'ok') {
        return { ok: false, error: `TikTok reply failed: ${res.error.code} ${res.error.message ?? ''}`, permanent: true }
      }
      return { ok: true, platformReplyId: res.data?.comment_id ? String(res.data.comment_id) : null }
    } catch (err) {
      return ttError(err)
    }
  },

  async sendDm(account, thread, text): Promise<SendResult> {
    if (!bmEnabled()) return { ok: false, permanent: true, error: NOT_GRANTED }
    try {
      const res = await http<{ data?: { message_id?: string }; error?: { code?: string; message?: string } }>(`${BM.base}${BM.dmSend}`, {
        method: 'POST',
        json: {
          conversation_id: thread.platformUid,
          peer_open_id: thread.participantId ?? undefined,
          content: JSON.stringify({ text }),
          content_type: 'TEXT',
        },
        headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        rateScope: `tiktok:${account.platformUid}:dm`,
        ratePerSec: 1,
        rateBurst: 3,
      })
      if (res.error && res.error.code !== 'ok') {
        const msg = res.error.message ?? ''
        const windowClosed = /window|expire|48/i.test(msg)
        return {
          ok: false,
          error: `TikTok DM failed: ${res.error.code} ${msg}${windowClosed ? ' (the 48-hour / 10-message reply window has closed)' : ''}`,
          permanent: true,
        }
      }
      return { ok: true, platformReplyId: res.data?.message_id ? String(res.data.message_id) : null }
    } catch (err) {
      return ttError(err)
    }
  },
}

function toComment(c: Record<string, unknown>, accountUid: string, contentUid?: string): NormalizedComment {
  const id = String(c.comment_id ?? c.id ?? '')
  const ts = Number(c.create_time ?? 0)
  return {
    platformUid: id,
    contentUid: contentUid ?? (c.video_id ? String(c.video_id) : null),
    parentUid: c.parent_comment_id ? String(c.parent_comment_id) : null,
    authorId: c.owner_open_id ? String(c.owner_open_id) : null,
    authorName: (c.owner_nickname as string) ?? (c.display_name as string) ?? null,
    authorHandle: (c.owner_username as string) ?? null,
    text: String(c.text ?? c.content ?? ''),
    permalink: null,
    createdAt: ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(),
    isOwn: c.owner_open_id ? String(c.owner_open_id) === accountUid : false,
    raw: c,
  }
}

function toMessage(m: Record<string, unknown>, accountUid: string): NormalizedMessage | null {
  const text = typeof m.content === 'string' ? safeParseContent(m.content) : String(m.text ?? m.content ?? '')
  const id = String(m.message_id ?? m.server_message_id ?? '')
  const ts = Number(m.create_time ?? m.server_message_create_time ?? 0)
  if (!id && !ts) return null
  const senderId = m.sender_open_id ? String(m.sender_open_id) : null
  return {
    platformUid: id || `${senderId}:${ts}`,
    threadUid: String(m.conversation_id ?? m.conversation_short_id ?? senderId ?? 'unknown'),
    direction: senderId && senderId !== accountUid ? 'inbound' : 'outbound',
    text,
    senderId,
    senderName: (m.sender_name as string) ?? null,
    createdAt: ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(),
    raw: m,
  }
}

function safeParseContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: string }
    return parsed.text ?? raw
  } catch {
    return raw
  }
}

function ttError(err: unknown): SendResult {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { code?: string; message?: string } } | undefined
    const msg = body?.error?.message ?? err.message
    const code = body?.error?.code
    const permanent = err.status === 400 || err.status === 401 || err.status === 402 || err.status === 403 || code === 'access_token_invalid'
    return {
      ok: false,
      error: `TikTok API ${err.status}${code ? ` (${code})` : ''}: ${msg}${
        err.status === 403 ? ' — Business Messaging access has not been granted to this app, or the account is not a Business Account with Advanced Access.' : ''
      }`,
      permanent,
      raw: err.body,
    }
  }
  return { ok: false, error: `TikTok API error: ${(err as Error).message}` }
}

export { bmEnabled as tiktokBusinessMessagingEnabled, NOT_GRANTED as TIKTOK_ACCESS_NOTICE }
export default tiktokAdapter

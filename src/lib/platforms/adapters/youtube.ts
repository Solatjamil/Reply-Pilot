
import { env } from '@/lib/env'
import { ApiError, http } from '@/lib/http'
import { PLATFORMS } from '../catalog'
import { buildAuthorizeUrl, exchangeCode, refreshOAuthToken } from '../oauth'
import type {
  ConnectableProfile,
  NormalizedComment,
  NormalizedContent,
  PlatformAdapter,
  SendResult,
  WebhookVerifyResult,
} from '../types'

const API = 'https://www.googleapis.com/youtube/v3'

interface YtChannel {
  id: string
  snippet?: { title?: string; description?: string; thumbnails?: { default?: { url?: string } }; customUrl?: string }
}

interface YtVideo {
  id: string
  snippet?: { title?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string } }; channelId?: string }
  statistics?: { commentCount?: string; viewCount?: string; likeCount?: string }
}

interface YtComment {
  id: string
  snippet?: {
    topLevelComment?: { id?: string; snippet?: YtCommentSnippet }
    textDisplay?: string
    authorDisplayName?: string
    authorChannelUrl?: string
    authorProfileImageUrl?: string
    publishedAt?: string
    totalReplyCount?: number
    videoId?: string
    parentId?: string
  }
  replies?: { comments?: { id: string; snippet?: YtCommentSnippet }[] }
}

interface YtCommentSnippet {
  textDisplay?: string
  authorDisplayName?: string
  authorChannelId?: { value?: string }
  authorChannelUrl?: string
  authorProfileImageUrl?: string
  publishedAt?: string
  parentId?: string
  videoId?: string
}

function authorIdFromUrl(url?: string): string | null {
  if (!url) return null
  const m = url.match(/channel\/([^/?#]+)/)
  return m ? m[1] : null
}

function stripHtml(s: string): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',

  isConfigured() {
    return env.google.configured
  },

  capabilities() {
    return PLATFORMS.youtube.capabilities
  },

  buildAuthorizeUrl(state) {
    return buildAuthorizeUrl('google', { redirectUri: `${env.appUrl}/api/oauth/google/callback`, state })
  },

  async completeConnection({ code }) {
    const tokens = await exchangeCode('google', { code, redirectUri: `${env.appUrl}/api/oauth/google/callback` })

    const channels = await http<{ items?: YtChannel[] }>(`${API}/channels`, {
      query: { part: 'snippet', mine: 'true', access_token: tokens.accessToken },
    })

    const profiles: ConnectableProfile[] = (channels.items ?? []).map((c) => ({
      platform: 'youtube',
      platformUid: c.id,
      name: c.snippet?.title ?? 'YouTube channel',
      handle: c.snippet?.customUrl ? c.snippet.customUrl.replace(/^@?/, '@') : null,
      avatarUrl: c.snippet?.thumbnails?.default?.url ?? null,
      profileUrl: c.snippet?.customUrl ? `https://youtube.com/${c.snippet.customUrl}` : `https://youtube.com/channel/${c.id}`,
    }))

    return { tokens, profiles }
  },

  async finalizeAccount({ profile }) {
    return {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      capabilities: JSON.stringify(PLATFORMS.youtube.capabilities),
    }
  },

  async refreshToken(account) {
    if (!account.refreshToken) return null
    return await refreshOAuthToken('google', account.refreshToken)
  },

  // YouTube has no comment webhooks — ingestion is poll-based.
  verifyWebhook(): WebhookVerifyResult {
    return { ok: false, status: 501, message: 'YouTube has no webhook API; ReplyPilot polls the YouTube Data API instead.' }
  },

  async listContent(ctx) {
    const { account } = ctx
    const uploads = await resolveUploadsPlaylistId(account.platformUid, account.accessToken!)
    if (!uploads) return []

    const res = await http<{ items?: { contentDetails?: { videoId?: string } }[] }>(`${API}/playlistItems`, {
      query: {
        part: 'contentDetails',
        playlistId: uploads,
        maxResults: 15,
        access_token: account.accessToken,
      },
      rateScope: `youtube:${account.platformUid}:read`,
      ratePerSec: 2,
    })

    const ids = (res.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean) as string[]
    if (!ids.length) return []

    const videos = await http<{ items?: YtVideo[] }>(`${API}/videos`, {
      query: { part: 'snippet,statistics', id: ids.join(','), access_token: account.accessToken },
      rateScope: `youtube:${account.platformUid}:read`,
      ratePerSec: 2,
    })

    return (videos.items ?? []).map<NormalizedContent>((v) => ({
      platformUid: v.id,
      type: 'video',
      text: v.snippet?.title ?? null,
      url: `https://youtube.com/watch?v=${v.id}`,
      thumbnailUrl: v.snippet?.thumbnails?.medium?.url ?? null,
      publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
      metrics: {
        comments: Number(v.statistics?.commentCount ?? 0),
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
      },
    }))
  },

  async listComments(ctx, content) {
    const { account } = ctx
    if (!content) return []
    const since = ctx.since?.getTime() ?? 0

    const res = await http<{ items?: YtComment[]; nextPageToken?: string }>(`${API}/commentThreads`, {
      query: {
        part: 'snippet,replies',
        videoId: content.platformUid,
        maxResults: 50,
        order: 'time',
        textFormat: 'plainText',
        access_token: account.accessToken,
      },
      rateScope: `youtube:${account.platformUid}:read`,
      ratePerSec: 2,
    })

    const out: NormalizedComment[] = []
    const ownId = account.platformUid

    for (const thread of res.items ?? []) {
      const top = thread.snippet?.topLevelComment?.snippet
      if (top?.textDisplay) {
        const created = top.publishedAt ? new Date(top.publishedAt) : new Date()
        const authorChannel = authorIdFromUrl(top.authorChannelUrl) ?? top.authorChannelId?.value ?? null
        if (!since || created.getTime() > since) {
          out.push({
            platformUid: String(thread.snippet?.topLevelComment?.id ?? thread.id),
            contentUid: content.platformUid,
            parentUid: null,
            authorId: authorChannel,
            authorName: top.authorDisplayName ?? null,
            text: stripHtml(top.textDisplay),
            permalink: `${content.url ?? ''}`.trim() || null,
            createdAt: created,
            isOwn: authorChannel === ownId,
            raw: top,
          })
        }
      }

      for (const reply of thread.replies?.comments ?? []) {
        const s = reply.snippet
        if (!s?.textDisplay) continue
        const created = s.publishedAt ? new Date(s.publishedAt) : new Date()
        const authorChannel = authorIdFromUrl(s.authorChannelUrl) ?? s.authorChannelId?.value ?? null
        if (since && created.getTime() <= since) continue
        out.push({
          platformUid: reply.id,
          contentUid: content.platformUid,
          parentUid: s.parentId ?? String(thread.snippet?.topLevelComment?.id ?? thread.id),
          authorId: authorChannel,
          authorName: s.authorDisplayName ?? null,
          text: stripHtml(s.textDisplay),
          permalink: content.url ?? null,
          createdAt: created,
          isOwn: authorChannel === ownId,
          raw: s,
        })
      }
    }
    return out
  },

  async sendCommentReply(account, comment, text) {
    if (!account.accessToken) return { ok: false, error: 'Missing YouTube access token — reconnect the channel.', permanent: true }
    try {
      // YouTube only allows replies to top-level comments; a reply to a reply
      // must be addressed to the top-level parent.
      const parentId = comment.parentUid ?? comment.platformUid
      const res = await http<{ id?: string }>(`${API}/commentThreads`, {
        method: 'POST',
        query: { part: 'snippet', access_token: account.accessToken },
        json: { snippet: { parentId, textOriginal: text } },
        rateScope: `youtube:${account.platformUid}:write`,
        ratePerSec: 1,
        rateBurst: 3,
      })
      return { ok: true, platformReplyId: res.id ?? null }
    } catch (err) {
      return ytError(err)
    }
  },

  // YouTube has no DM API.
  async sendDm() {
    return {
      ok: false,
      permanent: true,
      error: 'YouTube does not expose a public DM API — direct message automation is not possible on this platform.',
    } satisfies SendResult
  },
}

async function resolveUploadsPlaylistId(channelId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await http<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(`${API}/channels`, {
      query: { part: 'contentDetails', id: channelId, access_token: accessToken },
      rateScope: `youtube:${channelId}:read`,
      ratePerSec: 2,
    })
    const uploads = res.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
    if (uploads) return uploads
  } catch {
    /* fall through */
  }
  // Channel ids starting with UC map deterministically to their uploads playlist.
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : null
}

function ytError(err: unknown): SendResult {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { message?: string; errors?: { reason?: string }[] } } | undefined
    const reason = body?.error?.errors?.[0]?.reason
    const msg = body?.error?.message ?? err.message
    const permanent = err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404
    return { ok: false, error: `YouTube reply failed${reason ? ` (${reason})` : ''}: ${msg}`, permanent, raw: err.body }
  }
  return { ok: false, error: `YouTube reply failed: ${(err as Error).message}` }
}

export default youtubeAdapter


import { env } from '@/lib/env'
import { ApiError, http } from '@/lib/http'
import { PLATFORMS } from '../catalog'
import { buildAuthorizeUrl, exchangeCode } from '../oauth'
import type {
  AccountRecord,
  ConnectableProfile,
  NormalizedComment,
  NormalizedContent,
  PlatformAdapter,
  SendResult,
  WebhookVerifyResult,
} from '../types'

/**
 * LinkedIn Community Management API.
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
 *
 * Access requirements (this is the part people trip on):
 *   • Your LinkedIn app must be granted "Community Management API" access.
 *   • Scopes: r_organization_social + w_organization_social for company pages,
 *     w_member_social for personal profiles (r_member_social is currently a
 *     closed permission, so personal-profile comment READS may be unavailable).
 *   • LinkedIn messaging/DM automation is partner-gated — not implemented here.
 */

const API = 'https://api.linkedin.com'
const VERSION = new Date().toISOString().slice(0, 7).replace('-', '') // YYYYMM

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': process.env.LINKEDIN_VERSION || VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  }
}

/** restli requires URNs to be URL-encoded when used as a path segment. */
function urn(urnStr: string): string {
  return encodeURIComponent(urnStr)
}

interface LiOrganization {
  id: string | number
  localizedName?: string
  vanityName?: string
  logoV2?: { 'com.linkedin.common.VectorImage'?: { rootUrl?: string; artifacts?: { fileIdentifyingUrlPathSegment?: string }[] } }
}

interface LiComment {
  id?: string
  actor?: string
  message?: { 'com.linkedin.common.Message'?: { text?: string }; text?: string }
  created?: { actor?: string; time?: number }
  lastModified?: { actor?: string; time?: number }
  object?: string
  parentComment?: string
  content?: unknown
}

interface LiShare {
  id?: string
  urn?: string
  commentary?: { 'com.linkedin.common.Text'?: { text?: string }; text?: string }
  createdAt?: number
  firstPublishedAt?: number
  content?: { 'com.linkedin.ugc.ShareContent'?: { shareMediaCategory?: string; media?: { originalUrl?: string }[] } }
  distribution?: { 'com.linkedin.content.distribution.Distribution'?: { linkedInDistributionTarget?: string } }
}

function commentText(c: LiComment): string {
  return c.message?.['com.linkedin.common.Message']?.text ?? c.message?.text ?? ''
}

function personIdFromUrn(actor?: string): string | null {
  if (!actor) return null
  const m = actor.match(/urn:li:person:([^)]+)/)
  return m ? m[1] : null
}

export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',

  isConfigured() {
    return env.linkedin.configured
  },

  capabilities() {
    return PLATFORMS.linkedin_org.capabilities
  },

  buildAuthorizeUrl(state) {
    return buildAuthorizeUrl('linkedin', { redirectUri: `${env.appUrl}/api/oauth/linkedin/callback`, state })
  },

  async completeConnection({ code }) {
    const tokens = await exchangeCode('linkedin', { code, redirectUri: `${env.appUrl}/api/oauth/linkedin/callback` })

    const profiles: ConnectableProfile[] = []

    // The authenticated member
    try {
      const me = await http<{ sub?: string; name?: string; picture?: string; email?: string }>(`${API}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
      if (me.sub) {
        profiles.push({
          platform: 'linkedin_person',
          platformUid: me.sub,
          name: me.name || me.email || 'LinkedIn profile',
          handle: null,
          avatarUrl: me.picture ?? null,
          profileUrl: `https://www.linkedin.com/in/${me.sub}`,
          secrets: { personUrn: `urn:li:person:${me.sub}` },
          warning: 'r_member_social is a closed permission — reading comments on personal posts may fail until LinkedIn grants it.',
        })
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // openid/profile scope missing — carry on with organizations only.
      }
    }

    // Company pages the member administers
    try {
      const orgs = await http<{ elements?: LiOrganization[] }>(
        `${API}/v2/organizationalAcls?q=roleAssignee&projection=(elements*(organizationalTarget~(id,localizedName,vanityName,logoV2)))`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
      )
      for (const el of orgs.elements ?? []) {
        const org = (el as unknown as { 'organizationalTarget~'?: LiOrganization })['organizationalTarget~']
        if (!org?.id) continue
        const logo = org.logoV2?.['com.linkedin.common.VectorImage']
        const avatar = logo?.rootUrl && logo.artifacts?.[0]?.fileIdentifyingUrlPathSegment
          ? `${logo.rootUrl}${logo.artifacts[0].fileIdentifyingUrlPathSegment}`
          : null
        profiles.push({
          platform: 'linkedin_org',
          platformUid: String(org.id),
          name: org.localizedName ?? `Organization ${org.id}`,
          handle: org.vanityName ? `@${org.vanityName}` : null,
          avatarUrl: avatar,
          profileUrl: org.vanityName ? `https://www.linkedin.com/company/${org.vanityName}` : `https://www.linkedin.com/company/${org.id}`,
          secrets: { orgUrn: `urn:li:organization:${org.id}`, vanityName: org.vanityName ?? null },
        })
      }
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status}` : ''
      if (msg) {
        profiles.push({
          platform: 'linkedin_org',
          platformUid: 'unavailable',
          name: 'LinkedIn pages unavailable',
          warning: 'Could not list your company pages — the app is missing r_organization_social / rw_organization_admin, or Community Management API access has not been granted.',
        })
      }
    }

    return { tokens, profiles: profiles.filter((p) => p.platformUid !== 'unavailable') }
  },

  async finalizeAccount({ profile }) {
    const caps = profile.platform === 'linkedin_person' ? PLATFORMS.linkedin_person.capabilities : PLATFORMS.linkedin_org.capabilities
    return {
      name: profile.name,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      profileUrl: profile.profileUrl ?? null,
      capabilities: JSON.stringify(caps),
    }
  },

  // LinkedIn's basic OAuth flow issues 60-day tokens with no refresh token.
  async refreshToken() {
    return null
  },

  verifyWebhook(): WebhookVerifyResult {
    return {
      ok: false,
      status: 501,
      message: 'LinkedIn webhook subscriptions require partner-program access. ReplyPilot ingests LinkedIn comments by polling.',
    }
  },

  async listContent(ctx) {
    const { account } = ctx
    if (!account.accessToken) return []
    const isOrg = account.platform === 'linkedin_org'

    try {
      if (isOrg) {
        const orgUrn = String(account.secrets?.orgUrn ?? `urn:li:organization:${account.platformUid}`)
        const res = await http<{ elements?: LiShare[] }>(
          `${API}/rest/posts?q=author&author=${urn(orgUrn)}&count=25`,
          { headers: headers(account.accessToken), rateScope: `linkedin:${account.platformUid}:read`, ratePerSec: 2 },
        )
        return (res.elements ?? []).map((s) => toContent(s, orgUrn))
      }

      const personUrn = String(account.secrets?.personUrn ?? `urn:li:person:${account.platformUid}`)
      const res = await http<{ elements?: LiShare[] }>(
        `${API}/v2/ugcPosts?q=author&author=${urn(personUrn)}&count=25&sortBy=LAST_MODIFIED`,
        { headers: headers(account.accessToken), rateScope: `linkedin:${account.platformUid}:read`, ratePerSec: 2 },
      )
      return (res.elements ?? []).map((s) => toContent(s, personUrn))
    } catch (err) {
      throw normalizeLiError(err, 'list posts')
    }
  },

  async listComments(ctx, content) {
    const { account } = ctx
    if (!account.accessToken || !content) return []
    const since = ctx.since?.getTime() ?? 0
    const out: NormalizedComment[] = []
    const actorUrn = String(
      account.platform === 'linkedin_org'
        ? (account.secrets?.orgUrn ?? `urn:li:organization:${account.platformUid}`)
        : (account.secrets?.personUrn ?? `urn:li:person:${account.platformUid}`),
    )

    try {
      const objectUrn = content.metrics?.urn ? String(content.metrics.urn) : `urn:li:share:${content.platformUid}`
      const res = await http<{ elements?: LiComment[] }>(
        `${API}/rest/socialActions/${urn(objectUrn)}/comments?q=comments&count=100`,
        { headers: headers(account.accessToken), rateScope: `linkedin:${account.platformUid}:read`, ratePerSec: 2 },
      )

      for (const c of res.elements ?? []) {
        const text = commentText(c)
        if (!text.trim()) continue
        const ts = c.created?.time ?? c.lastModified?.time ?? Date.now()
        const created = new Date(ts)
        if (since && created.getTime() <= since) continue
        out.push({
          platformUid: String(c.id ?? `${objectUrn}:${ts}`),
          contentUid: content.platformUid,
          parentUid: c.parentComment ?? null,
          authorId: personIdFromUrn(c.actor),
          authorName: c.actor ?? null,
          text,
          permalink: `https://www.linkedin.com/feed/update/${encodeURIComponent(String(c.object ?? objectUrn))}`,
          createdAt: created,
          isOwn: c.actor === actorUrn,
          raw: c,
        })
      }
      return out
    } catch (err) {
      throw normalizeLiError(err, 'list comments')
    }
  },

  async sendCommentReply(account, comment, text) {
    if (!account.accessToken) return { ok: false, error: 'Missing LinkedIn access token — reconnect the account.', permanent: true }
    const actorUrn = String(
      account.platform === 'linkedin_org'
        ? (account.secrets?.orgUrn ?? `urn:li:organization:${account.platformUid}`)
        : (account.secrets?.personUrn ?? `urn:li:person:${account.platformUid}`),
    )
    // Reply into the thread: target the parent comment when there is one.
    const targetUrn = comment.parentUid
      ? comment.parentUid.startsWith('urn:')
        ? comment.parentUid
        : `urn:li:comment:${comment.parentUid}`
      : (comment as { contentUid?: string | null }).contentUid
        ? `urn:li:share:${(comment as { contentUid?: string | null }).contentUid}`
        : comment.platformUid.startsWith('urn:')
          ? comment.platformUid
          : `urn:li:comment:${comment.platformUid}`

    try {
      const res = await http<{ id?: string; status?: string }>(
        `${API}/rest/socialActions/${urn(targetUrn)}/comments`,
        {
          method: 'POST',
          headers: headers(account.accessToken),
          json: { actor: actorUrn, message: { text } },
          rateScope: `linkedin:${account.platformUid}:write`,
          ratePerSec: 1,
          rateBurst: 3,
        },
      )
      return { ok: true, platformReplyId: res.id ?? res.status ?? null }
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { message?: string; status?: number } | undefined
        const permanent = err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404
        return {
          ok: false,
          error: `LinkedIn comment failed (${err.status}): ${body?.message ?? 'request rejected'}${
            err.status === 403 ? ' — this usually means Community Management API access or w_organization_social has not been granted to your app.' : ''
          }`,
          permanent,
          raw: err.body,
        }
      }
      return { ok: false, error: `LinkedIn comment failed: ${(err as Error).message}` }
    }
  },

  async sendDm(): Promise<SendResult> {
    return {
      ok: false,
      permanent: true,
      error:
        'LinkedIn messaging automation requires the Messaging API partner program (Business Accounts). It is not available through the standard Community Management API.',
    }
  },
}

function toContent(s: LiShare, actorUrn: string): NormalizedContent {
  const id = String(s.id ?? '')
  const shareUrn = s.urn ?? `urn:li:share:${id}`
  const text = s.commentary?.['com.linkedin.common.Text']?.text ?? s.commentary?.text ?? null
  const published = s.firstPublishedAt ?? s.createdAt
  return {
    platformUid: id || shareUrn,
    type: 'post',
    text,
    url: `https://www.linkedin.com/feed/update/${encodeURIComponent(shareUrn)}`,
    publishedAt: published ? new Date(published) : null,
    metrics: { urn: shareUrn, actor: actorUrn },
  }
}

function normalizeLiError(err: unknown, what: string): Error {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | undefined
    const hint =
      err.status === 403
        ? ' (403 — grant Community Management API access + r_organization_social to your LinkedIn app)'
        : err.status === 401
          ? ' (401 — token expired, LinkedIn tokens last 60 days; reconnect the account)'
          : ''
    return new Error(`LinkedIn ${what} failed${hint}: ${body?.message ?? err.message}`)
  }
  return err as Error
}

export { headers as linkedinHeaders, urn as encodeUrn }
export default linkedinAdapter
export type { AccountRecord }

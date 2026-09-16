

export type Platform =
  | 'facebook_page'
  | 'instagram'
  | 'messenger'
  | 'tiktok'
  | 'youtube'
  | 'linkedin_org'
  | 'linkedin_person'
  | 'x'

export type ChannelKind = 'comment' | 'dm'

export interface PlatformCapabilities {
  /** Public API can read comments on the account's own posts. */
  readComments: boolean
  /** Public API can post a public reply to a comment. */
  replyToComment: boolean
  /** Public API can read inbound direct messages. */
  readDms: boolean
  /** Public API can send a DM in an existing conversation. */
  sendDm: boolean
  /** Can DM a commenter who never messaged us (Meta "private replies"). */
  privateReplyFromComment: boolean
  /** Real-time push (webhook) is available; otherwise we poll. */
  webhooks: boolean
  /** Can we list the account's own posts/videos? */
  listContent: boolean
  /** Can we delete/hide a comment? */
  moderateComments: boolean
  /** Human-readable blockers shown in the UI. */
  notes?: string[]
  /** Extra approval / partner-program steps required before this works. */
  requiresAccessRequest?: string[]
}

export interface PlatformMeta {
  id: Platform
  label: string
  short: string
  color: string
  icon: string
  kind: 'social' | 'messaging'
  docs: string
  capabilities: PlatformCapabilities
  connectEnabled: boolean
  /** Explains why connectEnabled is false, if applicable. */
  unavailableReason?: string
}

const FULL: PlatformCapabilities = {
  readComments: true,
  replyToComment: true,
  readDms: true,
  sendDm: true,
  privateReplyFromComment: true,
  webhooks: true,
  listContent: true,
  moderateComments: true,
}

export const PLATFORMS: Record<Platform, PlatformMeta> = {
  facebook_page: {
    id: 'facebook_page',
    label: 'Facebook Page',
    short: 'Facebook',
    color: '#1877F2',
    icon: 'facebook',
    kind: 'social',
    docs: 'https://developers.facebook.com/docs/graph-api',
    capabilities: FULL,
    connectEnabled: true,
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    short: 'Instagram',
    color: '#E1306C',
    icon: 'instagram',
    kind: 'social',
    docs: 'https://developers.facebook.com/docs/instagram-platform',
    capabilities: FULL,
    connectEnabled: true,
  },
  messenger: {
    id: 'messenger',
    label: 'Messenger',
    short: 'Messenger',
    color: '#0084FF',
    icon: 'messenger',
    kind: 'messaging',
    docs: 'https://developers.facebook.com/docs/messenger-platform',
    capabilities: { ...FULL, readComments: false, replyToComment: false, listContent: false, moderateComments: false },
    connectEnabled: true,
  },
  x: {
    id: 'x',
    label: 'X (Twitter)',
    short: 'X',
    color: '#0f1419',
    icon: 'x',
    kind: 'social',
    docs: 'https://docs.x.com/x-api',
    capabilities: {
      ...FULL,
      privateReplyFromComment: false,
      // Account Activity API (webhooks) is only on paid X API tiers.
      webhooks: true,
      notes: [
        'X realtime needs the Account Activity API, which requires a paid Pro/Enterprise tier plus OAuth 1.0a keys. Without it ReplyPilot polls instead.',
        'Comment ingestion uses polling of mentions + reply search (X API v2).',
        'Real-time webhooks need the Account Activity API, available on paid X tiers.',
        'DM read/send requires the user to have an existing conversation with you.',
      ],
    },
    connectEnabled: true,
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    short: 'YouTube',
    color: '#FF0000',
    icon: 'youtube',
    kind: 'social',
    docs: 'https://developers.google.com/youtube/v3/docs',
    capabilities: {
      readComments: true,
      replyToComment: true,
      readDms: false,
      sendDm: false,
      privateReplyFromComment: false,
      webhooks: false,
      listContent: true,
      moderateComments: true,
      notes: [
        'YouTube publishes no comment or message webhooks — ingestion is always by polling the Data API.',
        'YouTube has no public DM API — DM automation is not possible on this platform.',
        'Comments are ingested by polling recent uploads (no comment webhooks exist).',
        'Replies can only be posted to top-level comments.',
      ],
    },
    connectEnabled: true,
  },
  linkedin_org: {
    id: 'linkedin_org',
    label: 'LinkedIn Company Page',
    short: 'LinkedIn',
    color: '#0A66C2',
    icon: 'linkedin',
    kind: 'social',
    docs: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api',
    capabilities: {
      readComments: true,
      replyToComment: true,
      readDms: false,
      sendDm: false,
      privateReplyFromComment: false,
      webhooks: false,
      listContent: true,
      moderateComments: false,
      requiresAccessRequest: [
        'Community Management API access must be requested for your LinkedIn app (w_organization_social + r_organization_social).',
      ],
      notes: [
        'LinkedIn does not deliver comment events to third-party apps outside the relevant partner program, so ingestion is by polling.',
        'LinkedIn DM/messaging automation is restricted to Messaging API partners — comments work, DMs do not.',
        'Only comments on posts your page authored are readable.',
      ],
    },
    connectEnabled: true,
  },
  linkedin_person: {
    id: 'linkedin_person',
    label: 'LinkedIn Profile',
    short: 'LinkedIn',
    color: '#0A66C2',
    icon: 'linkedin',
    kind: 'social',
    docs: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api',
    capabilities: {
      readComments: true,
      replyToComment: true,
      readDms: false,
      sendDm: false,
      privateReplyFromComment: false,
      webhooks: false,
      listContent: true,
      moderateComments: false,
      notes: ['r_member_social is currently a closed permission — personal-profile comment reads may be unavailable.'],
    },
    connectEnabled: true,
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    short: 'TikTok',
    color: '#000000',
    icon: 'tiktok',
    kind: 'social',
    docs: 'https://developers.tiktok.com/',
    capabilities: {
      readComments: false,
      replyToComment: false,
      readDms: false,
      sendDm: false,
      privateReplyFromComment: false,
      webhooks: false,
      listContent: true,
      moderateComments: false,
      requiresAccessRequest: [
        'TikTok Business Messaging API is partner-gated (Open Beta) and requires a TikTok Business Account linked to TikTok for Business / Business Center for Advanced Access.',
        'Comment read/reply endpoints are only exposed to approved Business Messaging partners.',
      ],
      notes: [
        'TikTok exposes no public webhooks on these APIs, so ReplyPilot polls /v2/video/list/ and comment endpoints on a schedule.',
        'DM automation is unavailable for accounts registered in the EEA, Switzerland, the UK and India.',
        'Businesses cannot initiate DMs — only reply inside a 48h / 10-message window.',
        'Until your app is granted Business Messaging access, TikTok shows as connected with ingestion disabled.',
      ],
    },
    // Connect is allowed (OAuth works via Display API) but comment/DM ingestion
    // stays off until TikTok grants Business Messaging access.
    connectEnabled: true,
  },
}

export const PLATFORM_LIST = Object.values(PLATFORMS)

export function platformMeta(p: string): PlatformMeta | undefined {
  return PLATFORMS[p as Platform]
}

/** Human label for any stored platform string. */
export function platformLabel(p: string): string {
  return PLATFORMS[p as Platform]?.label ?? p
}

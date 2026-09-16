import type { Platform, PlatformCapabilities } from './catalog'

/**
 * Decrypted per-account credential blob. Shape varies by platform, so it
 * stays open — but never `any`: unknown values are read defensively.
 */
export type AccountSecrets = Record<string, unknown> & {
  accessToken?: string
  refreshToken?: string | null
  expiresAt?: string | null
  pageId?: string
  pageToken?: string
  igUserId?: string
  igUsername?: string
  region?: string
}

/** A profile/page the user picked during the OAuth flow. */
export interface ConnectableProfile {
  platform: Platform
  platformUid: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
  profileUrl?: string | null
  regionCode?: string | null
  /** Extra encrypted material (page token, org urn, api key...). */
  secrets?: Record<string, unknown>
  capabilities?: Partial<PlatformCapabilities>
  /** Informational warning shown in the picker, e.g. gated access. */
  warning?: string
}

export interface NormalizedComment {
  platformUid: string
  parentUid?: string | null
  contentUid?: string | null
  authorId?: string | null
  authorName?: string | null
  authorHandle?: string | null
  authorAvatar?: string | null
  text: string
  permalink?: string | null
  createdAt: Date
  isOwn: boolean
  raw?: unknown
}

export interface NormalizedMessage {
  platformUid: string
  threadUid: string
  direction: 'inbound' | 'outbound'
  text: string
  senderId?: string | null
  senderName?: string | null
  attachments?: unknown[]
  createdAt: Date
  /** Set when this DM was triggered from a public comment. */
  commentUid?: string | null
  raw?: unknown
}

export interface NormalizedThread {
  platformUid: string
  participantId?: string | null
  participantName?: string | null
  participantHandle?: string | null
  participantAvatar?: string | null
  lastMessageAt?: Date | null
  messages?: NormalizedMessage[]
}

export interface NormalizedContent {
  platformUid: string
  type: string
  text?: string | null
  url?: string | null
  thumbnailUrl?: string | null
  publishedAt?: Date | null
  metrics?: Record<string, unknown>
}

export interface SendResult {
  ok: boolean
  platformReplyId?: string | null
  error?: string
  /** True when the failure is permanent (don't retry). */
  permanent?: boolean
  raw?: unknown
}

export interface PollContext {
  account: AccountRecord
  since?: Date | null
  signal?: AbortSignal
}

/** The decrypted, ready-to-use view of an Account row. */
export interface AccountRecord {
  id: string
  workspaceId: string
  platform: Platform
  platformUid: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
  profileUrl?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  idToken?: string | null
  expiresAt?: Date | null
  scope?: string | null
  secrets: AccountSecrets
  capabilities: PlatformCapabilities
  regionCode?: string | null
  status: string
}

export interface PlatformAdapter {
  id: string
  /** True when the credentials needed to connect are present in .env. */
  isConfigured(): boolean
  capabilities(): PlatformCapabilities | Partial<PlatformCapabilities>

  // ── OAuth ──
  buildAuthorizeUrl?(state: string): string
  /** Exchanges the callback for tokens and lists what the user can attach. */
  completeConnection?(params: {
    code: string
    state: string
    workspaceId: string
    callbackUrl: string
    rawQuery: Record<string, string>
  }): Promise<{ tokens: TokenBundle; profiles: ConnectableProfile[] }>

  /** Converts a stored token bundle into the final Account fields. */
  finalizeAccount?(params: { profile: ConnectableProfile; tokens: TokenBundle; workspaceId: string }): Promise<Partial<AccountRow>>

  refreshToken?(account: AccountRecord): Promise<TokenBundle | null>

  // ── Webhooks ──
  verifyWebhook?(params: { method: string; query: Record<string, string>; rawBody: string; headers: Headers }): WebhookVerifyResult
  parseWebhook?(rawBody: string, headers: Headers): WebhookEvent[]

  // ── Ingestion (polling) ──
  listContent?(ctx: PollContext): Promise<NormalizedContent[]>
  listComments?(ctx: PollContext, content?: NormalizedContent): Promise<NormalizedComment[]>
  listThreads?(ctx: PollContext, opts?: { limit?: number }): Promise<NormalizedThread[]>

  // ── Sending ──
  sendCommentReply?(account: AccountRecord, comment: NormalizedComment | { platformUid: string; contentUid?: string | null; parentUid?: string | null }, text: string): Promise<SendResult>
  sendPrivateReply?(account: AccountRecord, comment: { platformUid: string }, text: string): Promise<SendResult>
  sendDm?(account: AccountRecord, thread: { platformUid: string; participantId?: string | null }, text: string): Promise<SendResult>
}

export interface TokenBundle {
  accessToken: string
  refreshToken?: string | null
  idToken?: string | null
  expiresIn?: number | null
  expiresAt?: Date | null
  scope?: string | null
  raw?: Record<string, unknown>
  /** Per-profile overrides (e.g. Meta page tokens). */
  profileSecrets?: Record<string, Record<string, unknown>>
}

export type AccountRow = {
  accessToken?: string | null
  refreshToken?: string | null
  idToken?: string | null
  expiresAt?: Date | null
  scope?: string | null
  rawTokens?: string | null
  secrets?: string | null
  capabilities?: string
  regionCode?: string | null
  handle?: string | null
  name?: string
  avatarUrl?: string | null
  profileUrl?: string | null
  status?: string
}

export type WebhookVerifyResult =
  | { ok: true; challenge?: string }
  | { ok: false; status?: number; message?: string }

export interface WebhookEvent {
  /** Which platform the event belongs to. */
  platform: Platform
  type: 'comment' | 'message' | 'mention' | 'reaction' | 'other'
  /** Used to find the Account row: page id, ig id, channel id, x user id... */
  accountUid: string
  comment?: NormalizedComment
  message?: NormalizedMessage
  thread?: NormalizedThread
  raw: unknown
}

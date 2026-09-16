
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { adapterFor, ensureFreshToken, getAccountRecord, markAccountError, markAccountHealthy } from '@/lib/platforms'
import type { AccountRecord } from '@/lib/platforms/types'
import type { NormalizedComment, NormalizedContent, NormalizedMessage, NormalizedThread, WebhookEvent } from '@/lib/platforms/types'

// ───────────────────────────── Account lookup ─────────────────────────────

/**
 * Finds the connected account a webhook event belongs to.
 *
 * Meta is special: one Facebook Login returns a Page, that Page's Messenger
 * inbox and its linked Instagram account, and the user attaches whichever
 * subset they want. All three can share the same underlying Page id, so an
 * exact (platform, platformUid) miss falls back to the Meta family before the
 * event is dropped as unmatched.
 */
const META_FAMILY = ['facebook_page', 'instagram', 'messenger']

export async function resolveAccount(platform: string, platformUid: string) {
  const exact = await prisma.account.findFirst({
    where: { platform, platformUid: String(platformUid), status: { not: 'revoked' } },
    include: { automation: true },
  })
  if (exact) return exact

  if (META_FAMILY.includes(platform)) {
    // Prefer the Page, then Messenger, then Instagram.
    const order = ['facebook_page', 'messenger', 'instagram'].filter((p) => p !== platform)
    const sibling = await prisma.account.findFirst({
      where: {
        platform: { in: [platform, ...order] },
        status: { not: 'revoked' },
        OR: [{ platformUid: String(platformUid) }, { secrets: { contains: platformUid } }],
      },
      include: { automation: true },
    })
    if (sibling) return sibling
  }
  return null
}

// ───────────────────────────── Usage counters ─────────────────────────────

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export async function bumpUsage(accountId: string, workspaceId: string, field: string, amount = 1) {
  const day = dayKey()
  const data: Record<string, number> = { [field]: amount }
  const res = await prisma.usageStat.updateMany({ where: { accountId, day }, data })
  if (res.count === 0) {
    try {
      await prisma.usageStat.create({ data: { accountId, workspaceId, day, ...data } })
    } catch {
      /* concurrent create — the counter will catch up next tick */
    }
  }
}

// ───────────────────────────── Content ingestion ──────────────────────────

export async function ingestContent(account: AccountRecord, content: NormalizedContent) {
  const existing = await prisma.content.findUnique({
    where: { accountId_platformUid: { accountId: account.id, platformUid: content.platformUid } },
  })
  const data = {
    workspaceId: account.workspaceId,
    accountId: account.id,
    platformUid: content.platformUid,
    type: content.type,
    text: content.text ?? null,
    url: content.url ?? null,
    thumbnailUrl: content.thumbnailUrl ?? null,
    publishedAt: content.publishedAt ?? null,
    metrics: JSON.stringify(content.metrics ?? {}),
  }
  if (existing) {
    return await prisma.content.update({ where: { id: existing.id }, data: { ...data, lastCheckedAt: new Date() } })
  }
  return await prisma.content.create({ data: { ...data, lastCheckedAt: new Date() } })
}

/** Pulls the account's recent posts, stores them, and queues comment polling. */
export async function pollAccountContent(account: AccountRecord): Promise<{ contents: number; queued: number }> {
  const adapter = adapterFor(account.platform)
  if (!adapter?.listContent || !adapter.listComments) return { contents: 0, queued: 0 }
  if (!account.capabilities?.listContent) return { contents: 0, queued: 0 }

  const fresh = await ensureFreshToken(account.id)
  const use = fresh ?? account

  const contents = await adapter.listContent({ account: use })
  let queued = 0
  for (const c of contents) {
    const row = await ingestContent(use, c)
    await prisma.content.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } })
    const id = await enqueue({
      type: 'poll_comments',
      accountId: use.id,
      workspaceId: use.workspaceId,
      payload: { contentId: row.id, platformUid: row.platformUid },
      key: `${use.id}:${row.platformUid}:${Math.floor(Date.now() / 60_000)}`,
      priority: 5,
    })
    if (id) queued++
  }
  return { contents: contents.length, queued }
}

/** Pulls comments for one post and turns each new one into a draft job. */
export async function pollContentComments(account: AccountRecord, contentId: string): Promise<{ found: number; created: number }> {
  const adapter = adapterFor(account.platform)
  if (!adapter?.listComments || !account.capabilities?.readComments) return { found: 0, created: 0 }

  const content = await prisma.content.findUnique({ where: { id: contentId } })
  if (!content) return { found: 0, created: 0 }

  const fresh = await ensureFreshToken(account.id)
  const use = fresh ?? account
  const since = content.lastCheckedAt ? new Date(content.lastCheckedAt.getTime() - 60_000) : null

  const comments = await adapter.listComments({ account: use, since }, {
    platformUid: content.platformUid,
    type: content.type,
    text: content.text,
    url: content.url,
  })

  let created = 0
  for (const c of comments) {
    const res = await ingestComment(account, c, content)
    if (res === 'created') created++
  }
  await prisma.content.update({ where: { id: contentId }, data: { lastCheckedAt: new Date() } })
  return { found: comments.length, created }
}

// ───────────────────────────── Comment ingestion ──────────────────────────

/** Returns 'created' for a brand-new actionable comment, 'duplicate'/'skipped' otherwise. */
export async function ingestComment(
  account: AccountRecord,
  comment: NormalizedComment,
  content?: { id?: string; platformUid?: string; text?: string | null; url?: string | null } | null,
): Promise<'created' | 'duplicate' | 'skipped'> {
  if (!comment.text?.trim()) return 'skipped'

  let contentId = content?.id ?? null
  if (!contentId && comment.contentUid) {
    const existing = await prisma.content.findUnique({
      where: { accountId_platformUid: { accountId: account.id, platformUid: comment.contentUid } },
    })
    if (existing) {
      contentId = existing.id
    } else {
      const created = await ingestContent(account, {
        platformUid: comment.contentUid,
        type: 'post',
        text: content?.text ?? null,
        url: content?.url ?? null,
      })
      contentId = created.id
    }
  }

  const existing = await prisma.comment.findUnique({
    where: { accountId_platformUid: { accountId: account.id, platformUid: comment.platformUid } },
  })

  const data = {
    workspaceId: account.workspaceId,
    accountId: account.id,
    contentId,
    platformUid: comment.platformUid,
    parentId: comment.parentUid ?? null,
    authorId: comment.authorId ?? null,
    authorName: comment.authorName ?? null,
    authorHandle: comment.authorHandle ?? null,
    authorAvatar: comment.authorAvatar ?? null,
    text: comment.text,
    permalink: comment.permalink ?? null,
    platform: account.platform,
    createdAt: comment.createdAt,
    isOwnComment: comment.isOwn,
  }

  if (existing) {
    await prisma.comment.update({ where: { id: existing.id }, data: { ...data, hidden: existing.hidden } })
    return 'duplicate'
  }

  const row = await prisma.comment.create({ data })
  await bumpUsage(account.id, account.workspaceId, 'inboundComments')
  await logEvent({
    workspaceId: account.workspaceId,
    accountId: account.id,
    type: 'comment.received',
    message: `${comment.authorName ?? comment.authorHandle ?? 'Someone'}: ${comment.text.slice(0, 120)}`,
    data: { commentId: row.id },
  })

  const cfg = await prisma.automationConfig.findUnique({ where: { accountId: account.id } })
  if (!cfg?.replyToComments) return 'skipped'
  if (comment.isOwn && cfg.skipOwnComments) return 'skipped'

  // Don't answer a thread we already answered (prevents bot-vs-bot loops).
  if (cfg.skipRepliesToUs && comment.parentUid) {
    const parent = await prisma.comment.findFirst({
      where: { accountId: account.id, platformUid: comment.parentUid },
    })
    if (parent?.isOwnComment) return 'skipped'
  }

  // Guard: how many times have we already auto-replied to this author on this post?
  if (comment.authorId && cfg.maxRepliesPerUser > 0 && contentId) {
    const already = await prisma.draft.count({
      where: {
        accountId: account.id,
        status: { in: ['sent', 'approved', 'scheduled', 'pending'] },
        comment: { authorId: comment.authorId, contentId },
      },
    })
    if (already >= cfg.maxRepliesPerUser) {
      await logEvent({
        workspaceId: account.workspaceId,
        accountId: account.id,
        type: 'comment.capped',
        level: 'debug',
        message: `Reply cap (${cfg.maxRepliesPerUser}) reached for ${comment.authorName ?? comment.authorId} on this post`,
      })
      return 'skipped'
    }
  }

  await enqueue({
    type: 'generate_draft',
    accountId: account.id,
    workspaceId: account.workspaceId,
    payload: { kind: 'comment_reply', commentId: row.id },
    key: `comment:${row.id}`,
    priority: 10,
  })
  return 'created'
}

// ───────────────────────────── Message ingestion ──────────────────────────

export async function ingestThread(account: AccountRecord, thread: NormalizedThread) {
  const existing = await prisma.thread.findUnique({
    where: { accountId_platformUid: { accountId: account.id, platformUid: thread.platformUid } },
  })
  const data = {
    workspaceId: account.workspaceId,
    accountId: account.id,
    platformUid: thread.platformUid,
    participantId: thread.participantId ?? null,
    // Never wipe profile fields we already know with nulls from a later event.
    participantName: thread.participantName ?? existing?.participantName ?? null,
    participantHandle: thread.participantHandle ?? existing?.participantHandle ?? null,
    participantAvatar: thread.participantAvatar ?? existing?.participantAvatar ?? null,
    lastMessageAt: thread.lastMessageAt ?? existing?.lastMessageAt ?? null,
  }
  const row = existing
    ? await prisma.thread.update({ where: { id: existing.id }, data })
    : await prisma.thread.create({ data: { ...data, firstInboundAt: thread.lastMessageAt ?? new Date() } })

  let inbound = 0
  for (const m of thread.messages ?? []) {
    const res = await ingestMessage(account, m, row.id)
    if (res === 'created' && m.direction === 'inbound') inbound++
  }
  return { threadId: row.id, inbound }
}

export async function ingestMessage(
  account: AccountRecord,
  message: NormalizedMessage,
  threadId?: string,
): Promise<'created' | 'duplicate' | 'skipped'> {
  if (!message.text?.trim()) return 'skipped'

  let tid = threadId
  if (!tid) {
    const key = message.threadUid || message.senderId || 'unknown'
    const existing = await prisma.thread.findUnique({
      where: { accountId_platformUid: { accountId: account.id, platformUid: key } },
    })
    if (existing) tid = existing.id
    else {
      const created = await prisma.thread.create({
        data: {
          workspaceId: account.workspaceId,
          accountId: account.id,
          platformUid: key,
          participantId: message.direction === 'inbound' ? message.senderId : null,
          participantName: message.senderName ?? null,
          lastMessageAt: message.createdAt,
          firstInboundAt: message.direction === 'inbound' ? message.createdAt : null,
        },
      })
      tid = created.id
    }
  }

  if (message.platformUid) {
    const dup = await prisma.message.findUnique({
      where: { accountId_platformUid_direction: { accountId: account.id, platformUid: message.platformUid, direction: message.direction } },
    })
    if (dup) return 'duplicate'
  }

  const row = await prisma.message.create({
    data: {
      workspaceId: account.workspaceId,
      accountId: account.id,
      threadId: tid,
      commentId: null,
      platformUid: message.platformUid || null,
      direction: message.direction,
      text: message.text,
      attachments: JSON.stringify(message.attachments ?? []),
      senderName: message.senderName ?? null,
      senderId: message.senderId ?? null,
      isEcho: message.direction === 'outbound',
      createdAt: message.createdAt,
    },
  })

  await prisma.thread.update({ where: { id: tid }, data: { lastMessageAt: message.createdAt } })

  if (message.direction !== 'inbound') return 'created'

  await bumpUsage(account.id, account.workspaceId, 'inboundMessages')
  await logEvent({
    workspaceId: account.workspaceId,
    accountId: account.id,
    type: 'message.received',
    message: `${message.senderName ?? message.senderId ?? 'Someone'}: ${message.text.slice(0, 120)}`,
    data: { messageId: row.id },
  })

  const cfg = await prisma.automationConfig.findUnique({ where: { accountId: account.id } })
  if (!cfg?.replyToDms) return 'created'

  // If a human has taken over this thread, stop automating it.
  const thread = await prisma.thread.findUnique({ where: { id: tid } })
  if (thread?.handedToHuman) return 'created'

  await enqueue({
    type: 'generate_draft',
    accountId: account.id,
    workspaceId: account.workspaceId,
    payload: { kind: 'dm_reply', messageId: row.id, threadId: tid },
    key: `message:${row.id}`,
    priority: 20, // DMs are more time-sensitive than comments
  })
  return 'created'
}

export async function pollAccountMessages(account: AccountRecord): Promise<{ threads: number; inbound: number }> {
  const adapter = adapterFor(account.platform)
  if (!adapter?.listThreads || !account.capabilities?.readDms) return { threads: 0, inbound: 0 }

  const fresh = await ensureFreshToken(account.id)
  const use = fresh ?? account
  const threads = await adapter.listThreads({ account: use }, { limit: 20 })

  let inbound = 0
  for (const t of threads) {
    const res = await ingestThread(use, t)
    inbound += res.inbound
  }
  return { threads: threads.length, inbound }
}

// ───────────────────────────── Webhook fan-out ────────────────────────────

export async function applyWebhookEvents(events: WebhookEvent[]): Promise<{ processed: number; matched: number }> {
  let processed = 0
  let matched = 0

  for (const event of events) {
    const account = await resolveAccount(event.platform, event.accountUid)
    if (!account) {
      await logEvent({
        type: 'webhook.unmatched',
        level: 'warn',
        message: `No connected ${event.platform} account for uid ${event.accountUid}`,
        data: { platform: event.platform, accountUid: event.accountUid, type: event.type },
      })
      continue
    }
    matched++
    const record = await getAccountRecord(account.id)
    if (!record) continue

    if (event.comment) {
      const content = event.comment.contentUid
        ? await prisma.content.findUnique({
            where: { accountId_platformUid: { accountId: record.id, platformUid: event.comment.contentUid } },
          })
        : null
      await ingestComment(record, event.comment, content)
      processed++
    }

    // A platform can send the conversation and the message in one event
    // (Meta does). Resolve the thread first, then store the message into it —
    // treating them as alternatives silently dropped every DM webhook.
    let threadId: string | undefined
    if (event.thread) {
      const { threadId: tid } = await ingestThread(record, event.thread)
      threadId = tid
      processed++
    }
    if (event.message) {
      await ingestMessage(record, event.message, threadId)
      processed++
    }
  }
  return { processed, matched }
}

export { markAccountError, markAccountHealthy }

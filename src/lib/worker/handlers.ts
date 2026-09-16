
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/log'
import { enqueue } from '@/lib/jobs/queue'
import { generateReplyDraft, withinVolumeCaps, inQuietHours, safeParse } from '@/lib/ai/reply-engine'
import { backfillEmbeddings } from '@/lib/ai/retrieval'
import { adapterFor, ensureFreshToken, getAccountRecord, markAccountError, markAccountHealthy } from '@/lib/platforms'
import { applyWebhookEvents, bumpUsage, pollAccountContent, pollAccountMessages, pollContentComments } from '@/lib/ingest'
import { PLATFORMS, type Platform } from '@/lib/platforms/catalog'

export interface JobContext {
  jobId: string
  type: string
  payload: Record<string, unknown>
  workspaceId: string | null
  accountId: string | null
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

// ─────────────────────────── generate_draft ───────────────────────────────

const generateDraft: JobHandler = async (ctx) => {
  const kind = String(ctx.payload.kind ?? 'comment_reply')
  const commentId = ctx.payload.commentId ? String(ctx.payload.commentId) : null
  const messageId = ctx.payload.messageId ? String(ctx.payload.messageId) : null
  const accountId = String(ctx.payload.accountId ?? ctx.accountId ?? '')
  if (!accountId) throw new Error('generate_draft: missing accountId')

  const account = await getAccountRecord(accountId)
  if (!account) throw new Error(`generate_draft: account ${accountId} not found`)
  if (account.status === 'error' || account.status === 'revoked') {
    return { skipped: `account status ${account.status}` }
  }

  const caps = account.capabilities
  if (kind === 'comment_reply' && !caps?.replyToComment) {
    await logEvent({
      accountId,
      workspaceId: account.workspaceId,
      type: 'draft.skipped',
      level: 'warn',
      message: `${PLATFORMS[account.platform]?.label ?? account.platform} does not allow automated comment replies for this app yet.`,
    })
    return { skipped: 'capability:replyToComment' }
  }
  if (kind === 'dm_reply' && !caps?.sendDm) {
    await logEvent({
      accountId,
      workspaceId: account.workspaceId,
      type: 'draft.skipped',
      level: 'warn',
      message: `${PLATFORMS[account.platform]?.label ?? account.platform} does not allow automated DMs for this app yet.`,
    })
    return { skipped: 'capability:sendDm' }
  }

  if (kind === 'comment_reply' && commentId) {
    const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: { content: true } })
    if (!comment) throw new Error(`generate_draft: comment ${commentId} not found`)
    if (comment.isAnswered) return { skipped: 'already_answered' }

    // Sibling comments give the model useful thread context.
    const siblings = comment.contentId
      ? await prisma.comment.findMany({
          where: { contentId: comment.contentId, id: { not: comment.id }, isOwnComment: false },
          orderBy: { createdAt: 'desc' },
          take: 4,
          select: { authorName: true, text: true },
        })
      : []

    const draft = await generateReplyDraft({
      workspaceId: account.workspaceId,
      accountId,
      kind: 'comment_reply',
      platform: account.platform as Platform,
      text: comment.text,
      authorName: comment.authorName,
      authorHandle: comment.authorHandle,
      authorId: comment.authorId,
      post: comment.content
        ? { text: comment.content.text, url: comment.content.url, type: comment.content.type }
        : null,
      history: siblings.reverse().map((s) => ({ role: 'customer' as const, text: `${s.authorName ?? 'user'}: ${s.text}` })),
      commentId: comment.id,
      createdAt: comment.createdAt,
      force: ctx.payload.force === true,
    })

    await trackLlmUsage(account, draft)
    return { draftId: draft.draftId, action: draft.action, confidence: draft.confidence, skipped: draft.skippedReason }
  }

  if ((kind === 'dm_reply' || kind === 'private_reply') && messageId) {
    const message = await prisma.message.findUnique({ where: { id: messageId }, include: { thread: true } })
    if (!message) throw new Error(`generate_draft: message ${messageId} not found`)
    if (message.direction !== 'inbound') return { skipped: 'outbound_message' }

    const history = await prisma.message.findMany({
      where: { threadId: message.threadId },
      orderBy: { createdAt: 'asc' },
      take: 20,
    })

    const draft = await generateReplyDraft({
      workspaceId: account.workspaceId,
      accountId,
      kind: kind === 'private_reply' ? 'private_reply' : 'dm_reply',
      platform: account.platform as Platform,
      text: message.text,
      authorName: message.senderName ?? message.thread?.participantName,
      authorId: message.senderId ?? message.thread?.participantId,
      history: history.map((m) => ({
        role: m.direction === 'inbound' ? ('customer' as const) : ('brand' as const),
        text: m.text,
        at: m.createdAt.toISOString(),
      })),
      messageId: message.id,
      threadId: message.threadId,
      createdAt: message.createdAt,
      force: ctx.payload.force === true,
    })

    await trackLlmUsage(account, draft)
    return { draftId: draft.draftId, action: draft.action, confidence: draft.confidence, skipped: draft.skippedReason }
  }

  return { skipped: 'unknown_kind' }
}

async function trackLlmUsage(
  account: { id: string; workspaceId: string },
  draft: { draftId?: string; llmProvider?: string; costUsd?: number; promptTokens?: number; outputTokens?: number },
) {
  if (!draft.draftId) return
  await bumpUsage(account.id, account.workspaceId, 'llmCalls')
  if (draft.costUsd) {
    await prisma.usageStat.updateMany({
      where: { accountId: account.id, day: new Date().toISOString().slice(0, 10) },
      data: { costUsd: { increment: draft.costUsd } },
    })
  }
}

// ───────────────────────────── send_draft ─────────────────────────────────

export const sendDraft: JobHandler = async (ctx) => {
  const draftId = String(ctx.payload.draftId ?? '')
  if (!draftId) throw new Error('send_draft: missing draftId')

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { account: true, comment: { include: { content: true } }, message: { include: { thread: true } }, thread: true },
  })
  if (!draft) throw new Error(`send_draft: draft ${draftId} not found`)
  if (draft.status === 'sent') return { alreadySent: true, platformReplyId: draft.platformReplyId }
  if (draft.status === 'rejected' || draft.status === 'ignored') return { skipped: draft.status }
  if (!draft.text.trim()) {
    await prisma.draft.update({ where: { id: draftId }, data: { status: 'ignored', error: 'empty draft' } })
    return { skipped: 'empty' }
  }

  const account = await getAccountRecord(draft.accountId)
  if (!account) throw new Error(`send_draft: account ${draft.accountId} not found`)

  const adapter = adapterFor(account.platform)
  if (!adapter) throw new Error(`send_draft: no adapter for ${account.platform}`)

  // Human-safety window: don't send while the account is in an error state.
  if (account.status === 'error' || account.status === 'revoked') {
    await prisma.draft.update({ where: { id: draftId }, data: { status: 'pending', action: 'review', error: `Account is ${account.status}` } })
    return { skipped: `account_${account.status}` }
  }

  await prisma.draft.update({ where: { id: draftId }, data: { status: 'sending' } })

  let result: { ok: boolean; platformReplyId?: string | null; error?: string; permanent?: boolean }

  if (draft.kind === 'comment_reply') {
    const comment = draft.comment
    if (!comment) throw new Error('send_draft: comment missing')
    if (!adapter.sendCommentReply) throw new Error(`${account.platform} cannot send comment replies`)
    result = await adapter.sendCommentReply(
      account,
      { platformUid: comment.platformUid, contentUid: comment.content?.platformUid ?? null, parentUid: comment.parentId },
      draft.text,
    )
  } else if (draft.kind === 'private_reply') {
    const comment = draft.comment
    if (!comment) throw new Error('send_draft: comment missing for private reply')
    if (!adapter.sendPrivateReply) throw new Error(`${account.platform} does not support private replies`)
    result = await adapter.sendPrivateReply(account, { platformUid: comment.platformUid }, draft.text)
  } else {
    const thread = draft.thread ?? draft.message?.thread
    if (!thread) throw new Error('send_draft: thread missing')
    if (!adapter.sendDm) throw new Error(`${account.platform} cannot send DMs`)
    result = await adapter.sendDm(
      account,
      { platformUid: thread.platformUid, participantId: thread.participantId ?? draft.message?.senderId ?? null },
      draft.text,
    )
  }

  if (result.ok) {
    const now = new Date()
    await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'sent', sentAt: now, platformReplyId: result.platformReplyId ?? null, error: null, decidedAt: draft.decidedAt ?? now },
    })
    if (draft.commentId) await prisma.comment.update({ where: { id: draft.commentId }, data: { isAnswered: true } })
    if (draft.messageId) {
      await prisma.message.create({
        data: {
          workspaceId: draft.workspaceId,
          accountId: draft.accountId,
          threadId: draft.threadId ?? draft.message?.threadId ?? '',
          direction: 'outbound',
          text: draft.text,
          isFromApi: true,
          senderName: account.name,
          createdAt: now,
        },
      }).catch(() => undefined)
    }
    await bumpUsage(account.id, account.workspaceId, draft.action === 'auto_send' ? 'autoSent' : 'approved')
    await logEvent({
      workspaceId: draft.workspaceId,
      accountId: draft.accountId,
      type: 'reply.sent',
      message: `${draft.action === 'auto_send' ? 'Auto-sent' : 'Sent'} ${draft.kind}: "${draft.text.slice(0, 100)}" (confidence ${draft.confidence.toFixed(2)})`,
      data: { draftId, platformReplyId: result.platformReplyId },
    })
    return { ok: true, platformReplyId: result.platformReplyId }
  }

  await prisma.draft.update({
    where: { id: draftId },
    data: { status: result.permanent ? 'failed' : 'pending', action: result.permanent ? 'escalate' : 'review', error: result.error ?? 'send failed' },
  })
  await bumpUsage(account.id, account.workspaceId, 'failed')
  await logEvent({
    workspaceId: draft.workspaceId,
    accountId: draft.accountId,
    type: 'reply.failed',
    level: 'error',
    message: result.error ?? 'send failed',
    data: { draftId, permanent: Boolean(result.permanent) },
  })

  // Token/permission failures are account-level problems (retryable ones only —
  // a permanent failure already surfaces in the draft's error message).
  if (!result.permanent && /token|permission|190|403|401|not authorized/i.test(result.error ?? '')) {
    await markAccountError(account.id, account.workspaceId, result.error ?? 'send failed')
  }

  if (result.permanent) return { ok: false, permanent: true, error: result.error }
  throw new Error(result.error ?? 'send failed (retryable)')
}

// ───────────────────────────── Polling jobs ───────────────────────────────

const pollContent: JobHandler = async (ctx) => {
  const account = await getAccountRecord(String(ctx.accountId))
  if (!account) return { skipped: 'no account' }
  const res = await pollAccountContent(account)
  await markAccountHealthy(account.id).catch(() => undefined)
  return res
}

const pollComments: JobHandler = async (ctx) => {
  const account = await getAccountRecord(String(ctx.accountId))
  if (!account) return { skipped: 'no account' }
  const contentId = String(ctx.payload.contentId ?? '')
  if (!contentId) return { skipped: 'no contentId' }
  return await pollContentComments(account, contentId)
}

const pollMessages: JobHandler = async (ctx) => {
  const account = await getAccountRecord(String(ctx.accountId))
  if (!account) return { skipped: 'no account' }
  const res = await pollAccountMessages(account)
  await markAccountHealthy(account.id).catch(() => undefined)
  return res
}

const refreshToken: JobHandler = async (ctx) => {
  const account = await ensureFreshToken(String(ctx.accountId))
  return { refreshed: Boolean(account) }
}

const embedKnowledge: JobHandler = async (ctx) => {
  const workspaceId = String(ctx.payload.workspaceId ?? ctx.workspaceId ?? '')
  if (!workspaceId) return { skipped: 'no workspaceId' }
  return await backfillEmbeddings(workspaceId)
}

/** Full account sync: content → comments → DMs. Triggered manually from the UI. */
const syncAccount: JobHandler = async (ctx) => {
  const account = await getAccountRecord(String(ctx.accountId))
  if (!account) return { skipped: 'no account' }
  const content = await pollAccountContent(account)
  const messages = account.capabilities?.readDms ? await pollAccountMessages(account) : { threads: 0, inbound: 0 }
  await markAccountHealthy(account.id).catch(() => undefined)
  return { content, messages }
}

/**
 * Webhook payloads are queued (not processed inline) so every platform's
 * webhook endpoint can ACK inside its SLA — Meta requires a 200 in <5s.
 */
const processWebhook: JobHandler = async (ctx) => {
  const platform = String(ctx.payload.platform ?? '')
  const rawBody = String(ctx.payload.rawBody ?? '')
  if (!platform || !rawBody) return { skipped: 'empty payload' }

  const adapter = adapterFor(platform)
  if (!adapter?.parseWebhook) return { skipped: `no webhook parser for ${platform}` }

  const events = adapter.parseWebhook(rawBody, new Headers((ctx.payload.headers as Record<string, string>) ?? {}))
  const result = await applyWebhookEvents(events)
  return { events: events.length, ...result }
}

export const HANDLERS: Record<string, JobHandler> = {
  process_webhook: processWebhook,
  generate_draft: generateDraft,
  send_draft: sendDraft,
  poll_content: pollContent,
  poll_comments: pollComments,
  poll_messages: pollMessages,
  refresh_token: refreshToken,
  embed_knowledge: embedKnowledge,
  sync_account: syncAccount,
}

// ─────────────────────────── Scheduling helpers ───────────────────────────

/** Enqueues the recurring poll jobs for every healthy, capable account. */
export async function schedulePolling(opts: { accountId?: string } = {}) {
  const accounts = await prisma.account.findMany({
    where: {
      ...(opts.accountId ? { id: opts.accountId } : {}),
      status: { in: ['active', 'pending_access'] },
    },
  })

  let queued = 0
  const bucket = Math.floor(Date.now() / 60_000)

  for (const row of accounts) {
    const account = await getAccountRecord(row.id)
    if (!account) continue
    const caps = account.capabilities

    if (caps?.listContent && caps?.readComments) {
      const id = await enqueue({
        type: 'poll_content',
        accountId: row.id,
        workspaceId: row.workspaceId,
        key: `${row.id}:${bucket}`,
        priority: 3,
      })
      if (id) queued++
    }

    if (caps?.readDms) {
      const id = await enqueue({
        type: 'poll_messages',
        accountId: row.id,
        workspaceId: row.workspaceId,
        key: `${row.id}:dm:${bucket}`,
        priority: 8,
      })
      if (id) queued++
    }

    if (row.expiresAt && row.expiresAt.getTime() - Date.now() < 30 * 60_000) {
      await enqueue({ type: 'refresh_token', accountId: row.id, workspaceId: row.workspaceId, key: `${row.id}:refresh:${bucket}` })
    }
  }
  return { accounts: accounts.length, queued }
}

/** Promotes due `scheduled` drafts into send jobs (with volume/quiet-hour guards). */
export async function dispatchScheduledDrafts() {
  const now = new Date()
  const due = await prisma.draft.findMany({
    where: { status: 'scheduled', action: 'auto_send', scheduledFor: { lte: now } },
    take: 25,
    orderBy: { scheduledFor: 'asc' },
  })

  let sent = 0
  let held = 0
  for (const draft of due) {
    const automation = await prisma.automationConfig.findUnique({ where: { accountId: draft.accountId } })
    if (automation) {
      const caps = await withinVolumeCaps(draft.accountId, draft.workspaceId, automation)
      if (!caps.ok || inQuietHours(automation)) {
        await prisma.draft.update({
          where: { id: draft.id },
          data: { status: 'pending', action: 'review', reasoning: `${draft.reasoning ?? ''} Held: ${caps.reason ?? 'quiet hours'}`.trim() },
        })
        held++
        continue
      }
    }
    const id = await enqueue({
      type: 'send_draft',
      accountId: draft.accountId,
      workspaceId: draft.workspaceId,
      payload: { draftId: draft.id },
      key: `send:${draft.id}:${draft.updatedAt.getTime()}`,
      priority: 20,
    })
    if (id) sent++
  }
  return { sent, held, due: due.length }
}

export { safeParse }

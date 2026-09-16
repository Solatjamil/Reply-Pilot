import { prisma } from '@/lib/db'
import type { InboxItem } from '@/components/inbox-client'

/**
 * A draft row plus the relations the inbox renders. `DRAFT_INCLUDE` below is
 * the single source of truth for that shape, so the two can't drift apart.
 */
export type DraftRow = Awaited<ReturnType<typeof prisma.draft.findFirstOrThrow<{ include: typeof DRAFT_INCLUDE }>>>

function parseList(raw: string | null): string[] {
  try {
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function parseCaps(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Maps a Prisma draft row (with its relations) into the UI's InboxItem shape. */
export function toInboxItem(d: DraftRow): InboxItem {
  return {
    id: d.id,
    kind: d.kind as InboxItem['kind'],
    status: d.status,
    action: d.action,
    text: d.text,
    alternates: parseList(d.alternates),
    confidence: d.confidence,
    intent: d.intent,
    sentiment: d.sentiment,
    language: d.language,
    reasoning: d.reasoning,
    flaggedFor: parseList(d.flaggedFor),
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    scheduledFor: d.scheduledFor?.toISOString() ?? null,
    sentAt: d.sentAt?.toISOString() ?? null,
    llmProvider: d.llmProvider,
    llmModel: d.llmModel,
    account: {
      id: d.account?.id ?? d.accountId,
      name: d.account?.name ?? 'Unknown',
      platform: d.account?.platform ?? 'unknown',
      handle: d.account?.handle ?? null,
      capabilities: parseCaps(d.account?.capabilities),
    },
    comment: d.comment
      ? {
          id: d.comment.id,
          text: d.comment.text,
          authorName: d.comment.authorName,
          authorHandle: d.comment.authorHandle,
          authorAvatar: d.comment.authorAvatar,
          permalink: d.comment.permalink,
          createdAt: d.comment.createdAt.toISOString(),
          content: d.comment.content
            ? { text: d.comment.content.text, url: d.comment.content.url, type: d.comment.content.type }
            : null,
        }
      : null,
    message: d.message
      ? { id: d.message.id, text: d.message.text, senderName: d.message.senderName, createdAt: d.message.createdAt.toISOString() }
      : null,
    thread: d.thread
      ? {
          id: d.thread.id,
          participantName: d.thread.participantName,
          participantHandle: d.thread.participantHandle,
          participantAvatar: d.thread.participantAvatar,
          handedToHuman: d.thread.handedToHuman,
        }
      : null,
    history: (d.thread?.messages ?? [])
      .slice(-12)
      .map((m: { id: string; direction: string; text: string; senderName: string | null; createdAt: Date }) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        senderName: m.senderName,
        createdAt: m.createdAt.toISOString(),
      })),
  }
}

export const DRAFT_INCLUDE = {
  account: { select: { id: true, name: true, platform: true, handle: true, capabilities: true } },
  comment: {
    select: {
      id: true,
      text: true,
      authorName: true,
      authorHandle: true,
      authorAvatar: true,
      permalink: true,
      createdAt: true,
      content: { select: { text: true, url: true, type: true } },
    },
  },
  message: { select: { id: true, text: true, senderName: true, createdAt: true } },
  thread: {
    select: {
      id: true,
      participantName: true,
      participantHandle: true,
      participantAvatar: true,
      handedToHuman: true,
      messages: { orderBy: { createdAt: 'asc' as const }, take: 12, select: { id: true, direction: true, text: true, senderName: true, createdAt: true } },
    },
  },
} satisfies object

export type DraftWithRelations = DraftRow

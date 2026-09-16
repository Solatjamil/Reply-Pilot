import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InboxClient, type InboxItem } from '@/components/inbox-client'
import { DRAFT_INCLUDE, toInboxItem } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

type Tab = 'queue' | 'sent' | 'comments' | 'dms'

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string; account?: string }> }) {
  const session = await getSession()
  if (!session) return null
  const params = await searchParams
  const tab = (['queue', 'sent', 'comments', 'dms'].includes(params.tab ?? '') ? params.tab : 'queue') as Tab
  const wid = session.wid

  const [queueCount, sentCount, commentCount, dmCount, automations] = await Promise.all([
    prisma.draft.count({ where: { workspaceId: wid, status: 'pending', action: { in: ['review', 'escalate'] } } }),
    prisma.draft.count({ where: { workspaceId: wid, status: 'sent' } }),
    prisma.comment.count({ where: { workspaceId: wid } }),
    prisma.thread.count({ where: { workspaceId: wid } }),
    prisma.automationConfig.findMany({ where: { workspaceId: wid } }),
  ])

  const accounts = await prisma.account.findMany({
    where: { workspaceId: wid },
    select: { id: true, name: true, platform: true },
    orderBy: { name: 'asc' },
  })

  const accountFilter = params.account && params.account !== 'all' ? { accountId: params.account } : {}

  let items: InboxItem[] = []

  if (tab === 'queue') {
    const drafts = await prisma.draft.findMany({
      where: { workspaceId: wid, status: 'pending', action: { in: ['review', 'escalate'] }, ...accountFilter },
      orderBy: [{ action: 'desc' }, { createdAt: 'desc' }],
      take: 60,
      include: DRAFT_INCLUDE,
    })
    const scheduled = await prisma.draft.findMany({
      where: { workspaceId: wid, status: 'scheduled', ...accountFilter },
      orderBy: { scheduledFor: 'asc' },
      take: 15,
      include: DRAFT_INCLUDE,
    })
    items = [...scheduled, ...drafts].map(toInboxItem)
  } else if (tab === 'sent') {
    const drafts = await prisma.draft.findMany({
      where: { workspaceId: wid, status: { in: ['sent', 'failed'] }, ...accountFilter },
      orderBy: { updatedAt: 'desc' },
      take: 80,
      include: DRAFT_INCLUDE,
    })
    items = drafts.map(toInboxItem)
  } else if (tab === 'comments') {
    const comments = await prisma.comment.findMany({
      where: { workspaceId: wid, ...accountFilter },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        content: { select: { text: true, url: true, type: true } },
        account: { select: { id: true, name: true, platform: true, handle: true, capabilities: true } },
        drafts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    items = comments.map((c) => {
      const d = c.drafts[0]
      if (d) return toInboxItem({ ...d, account: c.account, comment: { ...c, content: c.content }, message: null, thread: null })
      return {
        id: `nodraft:${c.id}`,
        targetId: c.id,
        kind: 'comment_reply',
        status: 'ignored',
        action: 'ignore',
        text: '',
        alternates: [],
        confidence: 0,
        intent: null,
        sentiment: null,
        language: null,
        reasoning: c.isOwnComment
          ? 'Your own comment — skipped.'
          : 'No draft was generated (automation off for this profile, or a rule skipped it).',
        flaggedFor: [],
        error: null,
        createdAt: c.createdAt.toISOString(),
        scheduledFor: null,
        sentAt: null,
        llmProvider: null,
        llmModel: null,
        account: {
          id: c.account.id,
          name: c.account.name,
          platform: c.account.platform,
          handle: c.account.handle,
          capabilities: safeJson(c.account.capabilities),
        },
        comment: {
          id: c.id,
          text: c.text,
          authorName: c.authorName,
          authorHandle: c.authorHandle,
          authorAvatar: c.authorAvatar,
          permalink: c.permalink,
          createdAt: c.createdAt.toISOString(),
          content: c.content ? { text: c.content.text, url: c.content.url, type: c.content.type } : null,
        },
        message: null,
        thread: null,
        history: [],
      } satisfies InboxItem
    })
  } else {
    const threads = await prisma.thread.findMany({
      where: { workspaceId: wid, ...accountFilter },
      orderBy: { lastMessageAt: 'desc' },
      take: 40,
      include: {
        account: { select: { id: true, name: true, platform: true, handle: true, capabilities: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 20 },
        drafts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    items = threads.map((t) => {
      const d = t.drafts[0]
      const lastInbound = [...t.messages].reverse().find((m) => m.direction === 'inbound') ?? null
      if (d) {
        return toInboxItem({
          ...d,
          account: t.account,
          comment: null,
          message: lastInbound,
          thread: { ...t, messages: t.messages },
        })
      }
      return {
        id: `nothread:${t.id}`,
        targetId: t.id,
        kind: 'dm_reply' as const,
        status: 'ignored',
        action: 'ignore',
        text: '',
        alternates: [],
        confidence: 0,
        intent: null,
        sentiment: null,
        language: null,
        reasoning: t.handedToHuman ? 'A human took over this conversation — automation is paused.' : 'No draft generated for this conversation yet.',
        flaggedFor: [],
        error: null,
        createdAt: (t.lastMessageAt ?? t.createdAt).toISOString(),
        scheduledFor: null,
        sentAt: null,
        llmProvider: null,
        llmModel: null,
        account: {
          id: t.account.id,
          name: t.account.name,
          platform: t.account.platform,
          handle: t.account.handle,
          capabilities: safeJson(t.account.capabilities),
        },
        comment: null,
        message: lastInbound ? { id: lastInbound.id, text: lastInbound.text, senderName: lastInbound.senderName, createdAt: lastInbound.createdAt.toISOString() } : null,
        thread: {
          id: t.id,
          participantName: t.participantName,
          participantHandle: t.participantHandle,
          participantAvatar: t.participantAvatar,
          handedToHuman: t.handedToHuman,
        },
        history: t.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.text,
          senderName: m.senderName,
          createdAt: m.createdAt.toISOString(),
        })),
      } satisfies InboxItem
    })
  }

  const defaultThreshold = automations[0]?.autoSendThreshold ?? 0.82

  return (
    <div className="space-y-6 fade-in">
      <header>
        <h1 className="h-page">Inbox</h1>
        <p className="muted mt-1">
          Every inbound comment and DM, with the AI reply ReplyPilot drafted. Approve, edit, regenerate or reject — anything at{' '}
          <span className="font-mono text-mist-200">{Math.round(defaultThreshold * 100)}%</span> confidence or above sends itself.
        </p>
      </header>

      <InboxClient
        items={items}
        accounts={accounts}
        counts={{ queue: queueCount, sent: sentCount, comments: commentCount, dms: dmCount }}
        autoSendThreshold={defaultThreshold}
      />
    </div>
  )
}

function safeJson(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Icon, PlatformIcon } from './icons'
import { Avatar, Badge, ConfidenceBar, EmptyState, relativeTime } from './ui'

export interface InboxItem {
  id: string
  kind: 'comment_reply' | 'dm_reply' | 'private_reply'
  status: string
  action: string
  text: string
  alternates: string[]
  confidence: number
  intent: string | null
  sentiment: string | null
  language: string | null
  reasoning: string | null
  flaggedFor: string[]
  error: string | null
  createdAt: string
  scheduledFor: string | null
  sentAt: string | null
  llmProvider: string | null
  llmModel: string | null
  account: { id: string; name: string; platform: string; handle: string | null; capabilities: Record<string, unknown> | null }
  comment: {
    id: string
    text: string
    authorName: string | null
    authorHandle: string | null
    authorAvatar: string | null
    permalink: string | null
    createdAt: string
    content: { text: string | null; url: string | null; type: string } | null
  } | null
  message: { id: string; text: string; senderName: string | null; createdAt: string } | null
  thread: { id: string; participantName: string | null; participantHandle: string | null; participantAvatar: string | null; handedToHuman: boolean } | null
  /** Set when this row is a comment/message that has no draft yet. */
  targetId?: string | null
  history: { id: string; direction: string; text: string; senderName: string | null; createdAt: string }[]
}

type Tab = 'queue' | 'sent' | 'comments' | 'dms'

const TABS: { id: Tab; label: string }[] = [
  { id: 'queue', label: 'Approval queue' },
  { id: 'sent', label: 'Sent' },
  { id: 'comments', label: 'All comments' },
  { id: 'dms', label: 'Conversations' },
]

export function InboxClient({
  items,
  accounts,
  counts,
  autoSendThreshold,
}: {
  items: InboxItem[]
  accounts: { id: string; name: string; platform: string }[]
  counts: { queue: number; sent: number; comments: number; dms: number }
  autoSendThreshold: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [accountId, setAccountId] = useState(params.get('account') ?? 'all')
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [openEditor, setOpenEditor] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const tab = (params.get('tab') as Tab) ?? 'queue'

  const filtered = useMemo(
    () => (accountId === 'all' ? items : items.filter((i) => i.account.id === accountId)),
    [items, accountId],
  )

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(params.toString())
    sp.set('tab', next)
    router.push(`/inbox?${sp.toString()}`)
  }

  const setAccount = (next: string) => {
    setAccountId(next)
    const sp = new URLSearchParams(params.toString())
    if (next === 'all') sp.delete('account')
    else sp.set('account', next)
    router.push(`/inbox?${sp.toString()}`)
  }

  const decide = async (item: InboxItem, action: string, extra?: Record<string, unknown>) => {
    const key = `${item.id}:${action}`
    setBusy(key)
    setNotice(null)
    try {
      const res = await fetch(`/api/drafts/${item.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; text?: string; confidence?: number }
      if (!res.ok) {
        setNotice({ tone: 'bad', text: json.error ?? `That failed (${res.status})` })
        return
      }
      if (action === 'regenerate' && json.text) {
        setNotice({ tone: 'good', text: `New draft (${Math.round((json.confidence ?? 0) * 100)}% confidence): ${json.text}` })
      } else {
        setNotice({
          tone: 'good',
          text:
            action === 'approve'
              ? 'Queued for sending — it will post in a moment.'
              : action === 'handoff'
                ? 'Automation paused for this conversation. A human should reply now.'
                : action === 'reject'
                  ? 'Rejected. Nothing was posted.'
                  : 'Updated.',
        })
      }
      setOpenEditor(null)
      startTransition(() => router.refresh())
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message })
    } finally {
      setBusy(null)
      setTimeout(() => setNotice(null), 6000)
    }
  }

  const generateFor = async (item: InboxItem) => {
    const key = `${item.id}:generate`
    setBusy(key)
    setNotice(null)
    const isComment = item.id.startsWith('nodraft:')
    const targetId = item.targetId ?? item.id.split(':')[1]
    try {
      const res = await fetch('/api/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isComment ? { commentId: targetId } : { messageId: item.message?.id ?? item.history?.at(-1)?.id }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setNotice({ tone: 'bad', text: json.error ?? `Could not queue the draft (${res.status})` })
      else setNotice({ tone: 'good', text: 'Draft queued — it will appear in the approval queue in a few seconds.' })
      startTransition(() => router.refresh())
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message })
    } finally {
      setBusy(null)
      setTimeout(() => setNotice(null), 6000)
    }
  }

  const canSend = (item: InboxItem) => {
    const caps = item.account.capabilities ?? {}
    if (item.kind === 'comment_reply') return caps.replyToComment !== false
    if (item.kind === 'private_reply') return caps.privateReplyFromComment !== false
    return caps.sendDm !== false
  }

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id ? 'bg-accent-500/15 text-white' : 'text-mist-400 hover:text-mist-200'
              }`}
            >
              {t.label}
              <span className="ml-1.5 font-mono text-[10px] text-mist-400">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <select value={accountId} onChange={(e) => setAccount(e.target.value)} className="input ml-auto w-auto py-1.5 text-xs">
          <option value="all">All profiles</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {notice ? (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
            notice.tone === 'good' ? 'border-mint-500/30 bg-mint-500/8 text-mint-400' : 'border-rose-400/30 bg-rose-400/8 text-rose-400'
          }`}
        >
          <Icon name={notice.tone === 'good' ? 'check' : 'warning'} size={15} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{notice.text}</span>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          title={tab === 'queue' ? 'Nothing waiting for approval' : 'Nothing here yet'}
          description={
            tab === 'queue'
              ? `Replies with confidence ≥ ${Math.round(autoSendThreshold * 100)}% send themselves. Everything else lands here for a one-click decision.`
              : 'Connect a profile and new comments or DMs will show up here automatically.'
          }
          icon={<Icon name="inbox" size={22} />}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => (
            <article key={item.id} className="card overflow-hidden">
              {/* Inbound context */}
              <div className="flex items-start gap-3 border-b border-ink-800 p-4">
                <Avatar
                  name={item.comment?.authorName ?? item.thread?.participantName ?? item.message?.senderName}
                  url={item.comment?.authorAvatar ?? item.thread?.participantAvatar}
                  platform={item.account.platform}
                  size={38}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-white">
                      {item.comment?.authorName ?? item.thread?.participantName ?? item.message?.senderName ?? 'Someone'}
                    </span>
                    {item.comment?.authorHandle ? <span className="text-xs text-mist-400">{item.comment.authorHandle}</span> : null}
                    <span className="text-xs text-mist-400">→ {item.account.name}</span>
                    <span className="text-xs text-mist-400">· {relativeTime(item.comment?.createdAt ?? item.message?.createdAt ?? item.createdAt)}</span>
                    {item.kind === 'dm_reply' ? <Badge tone="info">DM</Badge> : <Badge tone="neutral">comment</Badge>}
                    {item.intent ? <Badge tone="accent">{item.intent.replace('_', ' ')}</Badge> : null}
                    {item.sentiment === 'negative' ? <Badge tone="bad">negative</Badge> : null}
                  </div>

                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-mist-100">{item.comment?.text ?? item.message?.text}</p>

                  {item.comment?.content?.text ? (
                    <details className="mt-2.5">
                      <summary className="cursor-pointer text-[11px] text-mist-400 hover:text-mist-200">
                        On post: {item.comment.content.text.slice(0, 90)}
                        {item.comment.content.text.length > 90 ? '…' : ''}
                      </summary>
                      <p className="mt-1.5 rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-xs text-mist-300">{item.comment.content.text}</p>
                    </details>
                  ) : null}

                  {item.comment?.permalink ? (
                    <a
                      href={item.comment.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent-400 hover:underline"
                    >
                      View on <PlatformIcon platform={item.account.platform} size={11} />
                    </a>
                  ) : null}

                  {item.history?.length > 1 ? (
                    <details className="mt-2.5">
                      <summary className="cursor-pointer text-[11px] text-mist-400 hover:text-mist-200">Conversation ({item.history.length} messages)</summary>
                      <div className="mt-2 space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-3">
                        {item.history.map((m) => (
                          <div key={m.id} className={`flex gap-2 text-xs ${m.direction === 'outbound' ? 'justify-end' : ''}`}>
                            <div
                              className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
                                m.direction === 'outbound' ? 'bg-accent-500/15 text-mist-100' : 'bg-ink-700/70 text-mist-200'
                              }`}
                            >
                              {m.text}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>

              {/* AI draft */}
              <div className="p-4">
                <div className="mb-2.5 flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-400">
                    <Icon name="sparkle" size={13} /> AI draft
                  </span>
                  <ConfidenceBar value={item.confidence} threshold={autoSendThreshold} />
                  <StatusBadge item={item} />
                  {item.language && item.language !== 'en' ? <Badge tone="neutral">{item.language}</Badge> : null}
                  {item.llmModel ? <span className="font-mono text-[10px] text-mist-400/70">{item.llmProvider}/{item.llmModel}</span> : null}
                </div>

                {item.flaggedFor.length > 0 ? (
                  <div className="mb-2.5 flex flex-wrap gap-1.5">
                    {item.flaggedFor.map((f) => (
                      <Badge key={f} tone={f.startsWith('blocklist') ? 'bad' : 'warn'}>
                        {f.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                ) : null}

                {item.error ? (
                  <p className="mb-2.5 rounded-lg border border-rose-400/25 bg-rose-400/8 p-2.5 text-[11px] leading-relaxed text-rose-400/90">{item.error}</p>
                ) : null}

                {openEditor === item.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editing[item.id] ?? item.text}
                      onChange={(e) => setEditing({ ...editing, [item.id]: e.target.value })}
                      rows={3}
                      className="input font-sans"
                      autoFocus
                    />
                    <div className="flex items-center gap-2 text-[11px] text-mist-400">
                      <span className="font-mono">{(editing[item.id] ?? item.text).length} chars</span>
                      <button onClick={() => decide(item, 'edit', { text: editing[item.id] ?? item.text, sendNow: true })} disabled={busy !== null} className="btn-primary btn-sm ml-auto">
                        Save &amp; send
                      </button>
                      <button onClick={() => decide(item, 'edit', { text: editing[item.id] ?? item.text })} disabled={busy !== null} className="btn-ghost btn-sm">
                        Save only
                      </button>
                      <button onClick={() => setOpenEditor(null)} className="btn-ghost btn-sm">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850/70 p-3 text-sm leading-relaxed text-mist-100">
                    {item.text || <span className="italic text-mist-400">No reply drafted (skipped by your rules or by the model).</span>}
                  </p>
                )}

                {item.alternates?.length && openEditor !== item.id ? (
                  <div className="mt-2 space-y-1.5">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-mist-400">Alternatives</div>
                    {item.alternates.map((alt, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setEditing({ ...editing, [item.id]: alt })
                          setOpenEditor(item.id)
                        }}
                        className="block w-full rounded-lg border border-ink-700/70 bg-ink-900 p-2 text-left text-xs text-mist-300 transition-colors hover:border-accent-500/40 hover:text-mist-100"
                      >
                        {alt}
                      </button>
                    ))}
                  </div>
                ) : null}

                {item.reasoning ? (
                  <details className="mt-2.5">
                    <summary className="cursor-pointer text-[11px] text-mist-400 hover:text-mist-200">Why this decision?</summary>
                    <p className="mt-1.5 rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[11px] leading-relaxed text-mist-300">{item.reasoning}</p>
                  </details>
                ) : null}

                {/* Actions */}
                {item.id.startsWith('nodraft:') || item.id.startsWith('nothread:') ? (
                  <div className="mt-3.5 flex flex-wrap items-center gap-2">
                    <button onClick={() => generateFor(item)} disabled={busy !== null} className="btn-primary btn-sm">
                      <Icon name="sparkle" size={13} /> {busy === `${item.id}:generate` ? 'Drafting…' : 'Generate a draft'}
                    </button>
                    <span className="text-[11px] text-mist-400">Nothing was drafted automatically — {item.reasoning}</span>
                  </div>
                ) : null}

                {item.status !== 'sent' && !item.id.startsWith('nodraft:') && !item.id.startsWith('nothread:') ? (
                  <div className="mt-3.5 flex flex-wrap items-center gap-2">
                    {canSend(item) ? (
                      <button
                        onClick={() => decide(item, 'approve')}
                        disabled={busy !== null}
                        className="btn-primary btn-sm"
                      >
                        <Icon name="send" size={13} /> {busy === `${item.id}:approve` ? 'Sending…' : 'Approve & send'}
                      </button>
                    ) : (
                      <Badge tone="warn">Sending not available on this profile&apos;s API access</Badge>
                    )}
                    <button
                      onClick={() => {
                        setEditing({ ...editing, [item.id]: item.text })
                        setOpenEditor(item.id)
                      }}
                      className="btn-ghost btn-sm"
                    >
                      <Icon name="edit" size={13} /> Edit
                    </button>
                    <button onClick={() => decide(item, 'regenerate')} disabled={busy !== null} className="btn-ghost btn-sm">
                      <Icon name="refresh" size={13} /> {busy === `${item.id}:regenerate` ? 'Thinking…' : 'Regenerate'}
                    </button>
                    <button onClick={() => decide(item, 'reject', { reason: 'Rejected by reviewer' })} disabled={busy !== null} className="btn-ghost btn-sm text-mist-400 hover:text-rose-400">
                      <Icon name="close" size={13} /> Reject
                    </button>
                    {item.kind !== 'comment_reply' ? (
                      <button onClick={() => decide(item, 'handoff')} disabled={busy !== null} className="btn-ghost btn-sm">
                        <Icon name="user" size={13} /> Take over
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 text-xs text-mint-400">
                    <Icon name="check" size={14} /> Sent {relativeTime(item.sentAt)}
                    {item.comment?.permalink ? (
                      <a href={item.comment.permalink} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">
                        view thread
                      </a>
                    ) : null}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {pending ? <div className="fixed bottom-4 right-4 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-mist-300 shadow-xl">Refreshing…</div> : null}
    </div>
  )
}

function StatusBadge({ item }: { item: InboxItem }) {
  if (item.status === 'sent') return <Badge tone="good">sent</Badge>
  if (item.status === 'scheduled') return <Badge tone="accent">auto-send {item.scheduledFor ? relativeTime(item.scheduledFor) : 'soon'}</Badge>
  if (item.status === 'failed') return <Badge tone="bad">failed</Badge>
  if (item.status === 'rejected') return <Badge tone="neutral">rejected</Badge>
  if (item.status === 'ignored') return <Badge tone="neutral">ignored</Badge>
  if (item.action === 'escalate') return <Badge tone="bad">needs human</Badge>
  if (item.status === 'sending' || item.status === 'approved') return <Badge tone="accent">sending…</Badge>
  return <Badge tone="warn">awaiting approval</Badge>
}

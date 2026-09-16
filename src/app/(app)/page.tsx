import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Badge, EmptyState, Stat, relativeTime } from '@/components/ui'
import { Icon, PlatformIcon } from '@/components/icons'
import { aiConfigured, configuredPlatforms, env } from '@/lib/env'
import { dayKey } from '@/lib/ingest'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const session = await getSession()
  if (!session) return null
  const wid = session.wid
  const today = dayKey()

  const [accounts, pending, sentToday, autoToday, comments7d, messages7d, recentDrafts, logs, queue] = await Promise.all([
    prisma.account.findMany({ where: { workspaceId: wid }, orderBy: { connectedAt: 'desc' }, include: { automation: true } }),
    prisma.draft.count({ where: { workspaceId: wid, status: 'pending', action: { in: ['review', 'escalate'] } } }),
    prisma.draft.count({ where: { workspaceId: wid, status: 'sent', sentAt: { gte: new Date(`${today}T00:00:00.000Z`) } } }),
    prisma.draft.count({ where: { workspaceId: wid, status: 'sent', action: 'auto_send', sentAt: { gte: new Date(`${today}T00:00:00.000Z`) } } }),
    prisma.comment.count({ where: { workspaceId: wid, createdAt: { gte: new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 6 * 86_400_000) } } }),
    prisma.message.count({ where: { workspaceId: wid, direction: 'inbound', createdAt: { gte: new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 6 * 86_400_000) } } }),
    prisma.draft.findMany({
      where: { workspaceId: wid },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { account: { select: { name: true, platform: true, handle: true } }, comment: { select: { text: true, authorName: true } }, message: { select: { text: true, senderName: true } } },
    }),
    prisma.eventLog.findMany({ where: { workspaceId: wid }, orderBy: { createdAt: 'desc' }, take: 8 }),
    prisma.job.groupBy({ by: ['status'], where: { workspaceId: wid }, _count: { _all: true } }),
  ])

  const missing = configuredPlatforms().filter((p) => !p.ok)
  const needsAi = !aiConfigured()
  const queued = queue.find((q) => q.status === 'queued')?._count._all ?? 0
  const failedJobs = queue.find((q) => q.status === 'failed')?._count._all ?? 0
  const brokenAccounts = accounts.filter((a) => a.status === 'error' || a.status === 'pending_access')

  return (
    <div className="space-y-7 fade-in">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h-page">Good {greeting()}, {session.email.split('@')[0]}</h1>
          <p className="muted mt-1">
            {accounts.length === 0
              ? 'Connect a social profile to start auto-replying to comments and DMs.'
              : `${accounts.length} profile${accounts.length === 1 ? '' : 's'} connected · ${pending} waiting for you`}
          </p>
        </div>
        <div className="flex gap-2">
          {pending > 0 ? (
            <Link href="/inbox" className="btn-primary">
              <Icon name="inbox" size={16} /> Review {pending}
            </Link>
          ) : null}
          <Link href="/accounts" className="btn-ghost">
            <Icon name="plus" size={16} /> Connect profile
          </Link>
        </div>
      </header>

      {needsAi ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-400/8 p-4">
          <span className="mt-0.5 text-amber-400">
            <Icon name="warning" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-amber-400">No AI provider key found</div>
            <p className="mt-1 text-xs text-mist-300">
              Add <code className="rounded bg-ink-800 px-1 py-0.5 font-mono">OPENAI_API_KEY</code> (or ANTHROPIC / GOOGLE / GROQ / OPENROUTER) to{' '}
              <code className="rounded bg-ink-800 px-1 py-0.5 font-mono">.env</code> and restart. Until then drafts cannot be generated.
            </p>
          </div>
          <Link href="/settings" className="btn-ghost btn-sm shrink-0">Open settings</Link>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sent today" value={sentToday} hint={`${autoToday} auto-sent without review`} tone="good" icon={<Icon name="send" size={18} />} />
        <Stat label="Awaiting approval" value={pending} hint={pending ? 'One click to send or edit' : 'Queue is clear'} tone={pending ? 'warn' : 'neutral'} icon={<Icon name="clock" size={18} />} />
        <Stat label="Comments · 7d" value={comments7d} hint="Ingested from all profiles" icon={<Icon name="inbox" size={18} />} />
        <Stat label="DMs · 7d" value={messages7d} hint="Inbound conversations" icon={<Icon name="bolt" size={18} />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Latest AI activity</h2>
            <Link href="/inbox" className="text-xs text-accent-400 hover:text-accent-400/80">Open inbox →</Link>
          </div>

          {recentDrafts.length === 0 ? (
            <EmptyState
              title="No replies generated yet"
              description="Once a comment or DM lands on a connected profile, ReplyPilot drafts an answer, scores its confidence, and either sends it or queues it here for you."
              action={<Link href="/accounts" className="btn-primary">Connect a profile</Link>}
            />
          ) : (
            <div className="card divide-y divide-ink-800">
              {recentDrafts.map((d) => {
                const inbound = d.comment?.text ?? d.message?.text ?? ''
                const author = d.comment?.authorName ?? d.message?.senderName ?? 'Someone'
                return (
                  <Link key={d.id} href="/inbox" className="flex items-start gap-3 p-4 transition-colors hover:bg-ink-850/60">
                    <PlatformIcon platform={d.account.platform} size={16} className="mt-1 shrink-0 text-mist-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-mist-200">{author}</span>
                        <span className="text-xs text-mist-400">on {d.account.name}</span>
                        <span className="text-xs text-mist-400">· {relativeTime(d.createdAt)}</span>
                        <StatusBadge status={d.status} action={d.action} />
                      </div>
                      <p className="mt-1.5 truncate text-sm text-mist-300">{inbound}</p>
                      {d.text ? <p className="mt-1 line-clamp-2 text-sm text-mist-100">↳ {d.text}</p> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-xs text-mist-400">{Math.round(d.confidence * 100)}%</div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Connected profiles</h2>
          {accounts.length === 0 ? (
            <div className="card-pad text-sm text-mist-400">
              Nothing connected yet.{' '}
              <Link href="/accounts" className="text-accent-400 hover:underline">Attach a profile →</Link>
            </div>
          ) : (
            <div className="card divide-y divide-ink-800">
              {accounts.slice(0, 6).map((a) => (
                <div key={a.id} className="flex items-center gap-3 p-3.5">
                  <PlatformIcon platform={a.platform} size={18} className="shrink-0 text-mist-300" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-mist-100">{a.name}</div>
                    <div className="truncate text-xs text-mist-400">{a.handle ?? a.platformUid}</div>
                  </div>
                  <AccountStatusBadge status={a.status} automationOn={Boolean(a.automation?.replyToComments || a.automation?.replyToDms)} />
                </div>
              ))}
            </div>
          )}

          {brokenAccounts.length > 0 ? (
            <div className="card-pad border-amber-400/25 bg-amber-400/5">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                <Icon name="warning" size={15} /> {brokenAccounts.length} profile(s) need attention
              </div>
              <ul className="mt-2 space-y-1.5">
                {brokenAccounts.slice(0, 3).map((a) => (
                  <li key={a.id} className="text-xs text-mist-300">
                    <span className="font-medium text-mist-100">{a.name}:</span> {a.lastError ?? (a.status === 'pending_access' ? 'waiting on platform API access' : a.status)}
                  </li>
                ))}
              </ul>
              <Link href="/accounts" className="btn-ghost btn-sm mt-3 w-full">Fix now</Link>
            </div>
          ) : null}

          <div className="card-pad">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-mist-300">Queue</span>
              <span className="font-mono text-mist-400">{queued} queued</span>
            </div>
            {failedJobs > 0 ? <div className="mt-1 text-xs text-rose-400">{failedJobs} failed job(s)</div> : null}
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="font-medium text-mist-300">Missing platform keys</span>
              <span className="font-mono text-mist-400">{missing.length ? `${missing.length}/5` : 'none'}</span>
            </div>
            <Link href="/settings" className="btn-ghost btn-sm mt-3 w-full">Setup checklist</Link>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Recent events</h2>
          <Link href="/logs" className="text-xs text-accent-400 hover:text-accent-400/80">Full log →</Link>
        </div>
        <div className="card divide-y divide-ink-800">
          {logs.length === 0 ? (
            <div className="p-5 text-sm text-mist-400">Nothing yet — events appear here as profiles connect and replies flow.</div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.level === 'error' ? 'bg-rose-400' : l.level === 'warn' ? 'bg-amber-400' : 'bg-mint-500'}`} />
                <span className="w-32 shrink-0 font-mono text-mist-400">{l.type}</span>
                <span className="min-w-0 flex-1 text-mist-300">{l.message}</span>
                <span className="shrink-0 text-mist-400">{relativeTime(l.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <p className="pb-2 text-center text-[11px] text-mist-400/70">
        Webhook base URL: <code className="font-mono text-mist-300">{env.appUrl}</code>
      </p>
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
}

function StatusBadge({ status, action }: { status: string; action: string }) {
  if (status === 'sent') return <Badge tone="good">sent</Badge>
  if (status === 'scheduled') return <Badge tone="accent">scheduled</Badge>
  if (status === 'failed') return <Badge tone="bad">failed</Badge>
  if (status === 'rejected') return <Badge tone="neutral">rejected</Badge>
  if (status === 'ignored') return <Badge tone="neutral">ignored</Badge>
  if (action === 'escalate') return <Badge tone="bad">needs human</Badge>
  return <Badge tone="warn">awaiting approval</Badge>
}

function AccountStatusBadge({ status, automationOn }: { status: string; automationOn: boolean }) {
  if (status === 'error') return <Badge tone="bad">error</Badge>
  if (status === 'pending_access') return <Badge tone="warn">access pending</Badge>
  if (status === 'revoked') return <Badge tone="neutral">revoked</Badge>
  return automationOn ? <Badge tone="good"><span className="pulse-dot">●</span> live</Badge> : <Badge tone="warn">paused</Badge>
}

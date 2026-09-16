import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Badge, EmptyState, relativeTime } from '@/components/ui'
import { Icon } from '@/components/icons'
import { queueStats } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

const LEVEL_DOT: Record<string, string> = {
  error: 'bg-rose-400',
  warn: 'bg-amber-400',
  info: 'bg-mint-500',
  debug: 'bg-mist-500',
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const session = await getSession()
  if (!session) return null
  const params = await searchParams

  const [events, jobs, stats, types] = await Promise.all([
    prisma.eventLog.findMany({
      where: { workspaceId: session.wid, ...(params.type ? { type: params.type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { account: { select: { name: true, platform: true } } },
    }),
    prisma.job.findMany({
      where: { workspaceId: session.wid },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      include: { account: { select: { name: true, platform: true } } },
    }),
    queueStats(session.wid),
    prisma.eventLog.findMany({ where: { workspaceId: session.wid }, distinct: ['type'], select: { type: true }, take: 40 }),
  ])

  return (
    <div className="space-y-6 fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h-page">Activity log</h1>
          <p className="muted mt-1">Every webhook, draft, send, failure and token refresh — the first place to look when something is not replying.</p>
        </div>
        <form action="/api/jobs/run" method="post">
          <button type="submit" className="btn-ghost">
            <Icon name="refresh" size={15} /> Run queue now
          </button>
        </form>
      </header>

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ['Queued', stats.queued, 'neutral'],
          ['Running', stats.running, 'accent'],
          ['Completed', stats.done, 'good'],
          ['Failed', stats.failed, stats.failed ? 'bad' : 'neutral'],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className="card-pad">
            <div className="text-xs uppercase tracking-wide text-mist-400">{label}</div>
            <div className="mt-1.5 text-xl font-semibold text-white">{String(value)}</div>
            <Badge tone={tone as BadgeTone} className="mt-2">jobs</Badge>
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Events</h2>
          <Link href="/logs" className={`chip ${!params.type ? 'border-accent-500/40 text-white' : ''}`}>all</Link>
          {types.map((t) => (
            <Link key={t.type} href={`/logs?type=${encodeURIComponent(t.type)}`} className={`chip ${params.type === t.type ? 'border-accent-500/40 text-white' : ''}`}>
              {t.type}
            </Link>
          ))}
        </div>
        {events.length === 0 ? (
          <EmptyState title="No events yet" description="Events appear as soon as profiles connect and webhooks or polling bring in comments and DMs." />
        ) : (
          <div className="card divide-y divide-ink-800">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[e.level] ?? 'bg-mint-500'}`} />
                <span className="w-36 shrink-0 font-mono text-[11px] text-mist-400">{e.type}</span>
                <span className="min-w-0 flex-1 text-xs text-mist-300">
                  {e.message}
                  {e.account ? <span className="ml-2 text-mist-400/70">({e.account.name})</span> : null}
                </span>
                <span className="shrink-0 text-[11px] text-mist-400">{relativeTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Recent jobs</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-mist-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Account</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Attempts</th>
                <th className="px-4 py-2.5 font-medium">Error</th>
                <th className="px-4 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="px-4 py-2.5 font-mono text-mist-300">{j.type}</td>
                  <td className="px-4 py-2.5 text-mist-400">{j.account?.name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={j.status === 'done' ? 'good' : j.status === 'failed' ? 'bad' : j.status === 'running' ? 'accent' : 'neutral'}>{j.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-mist-400">{j.attempts}</td>
                  <td className="max-w-md truncate px-4 py-2.5 text-mist-400">{j.lastError ?? ''}</td>
                  <td className="px-4 py-2.5 text-mist-400">{relativeTime(j.updatedAt)}</td>
                </tr>
              ))}
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-mist-400">
                    No jobs yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

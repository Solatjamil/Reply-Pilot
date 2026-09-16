import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Badge, EmptyState, Stat } from '@/components/ui'
import { Icon, PlatformIcon } from '@/components/icons'
import { dayKey } from '@/lib/ingest'

export const dynamic = 'force-dynamic'

export default async function AnalyticsPage() {
  const session = await getSession()
  if (!session) return null
  const wid = session.wid
  const days = 14
  // Anchor the window to the start of today rather than reading the clock
  // directly during render (react-hooks/purity), which also makes the 14-day
  // series stable across re-renders.
  const startOfToday = new Date(`${dayKey()}T00:00:00.000Z`)
  const since = new Date(startOfToday.getTime() - (days - 1) * 86_400_000)
  const sinceKey = dayKey(since)

  const [daily, totals, intents, accounts, platformCounts] = await Promise.all([
    prisma.usageStat.findMany({ where: { workspaceId: wid, day: { gte: sinceKey } }, orderBy: { day: 'asc' } }),
    prisma.$transaction([
      prisma.draft.count({ where: { workspaceId: wid, status: 'sent', sentAt: { gte: since } } }),
      prisma.draft.count({ where: { workspaceId: wid, status: 'sent', action: 'auto_send', sentAt: { gte: since } } }),
      prisma.draft.count({ where: { workspaceId: wid, status: 'rejected', decidedAt: { gte: since } } }),
      prisma.draft.count({ where: { workspaceId: wid, status: 'pending' } }),
      prisma.draft.aggregate({ where: { workspaceId: wid, createdAt: { gte: since } }, _avg: { confidence: true }, _sum: { costUsd: true }, _count: { _all: true } }),
      prisma.comment.count({ where: { workspaceId: wid, createdAt: { gte: since } } }),
      prisma.message.count({ where: { workspaceId: wid, direction: 'inbound', createdAt: { gte: since } } }),
    ]),
    prisma.draft.groupBy({ by: ['intent'], where: { workspaceId: wid, createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { intent: 'desc' } } }),
    prisma.account.findMany({
      where: { workspaceId: wid },
      select: { id: true, name: true, platform: true, _count: { select: { comments: true, drafts: true, threads: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.draft.groupBy({ by: ['accountId'], where: { workspaceId: wid, status: 'sent', sentAt: { gte: since } }, _count: { _all: true } }),
  ])

  const [sent, autoSent, rejected, pending, agg, comments, messages] = totals
  const autoRate = sent ? Math.round((autoSent / sent) * 100) : 0
  const approvalRate = sent + rejected ? Math.round((sent / (sent + rejected)) * 100) : 0
  const totalCost = Number((agg._sum.costUsd ?? 0).toFixed(2))
  const avgConfidence = Math.round((agg._avg.confidence ?? 0) * 100)
  const sentByAccount = new Map(platformCounts.map((p) => [p.accountId, p._count._all]))

  // Build a continuous day series (fills gaps with zeros)
  const series: { day: string; inbound: number; auto: number; approved: number; rejected: number }[] = []
  const byDay = new Map(daily.map((d) => [d.day, d]))
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(startOfToday.getTime() - i * 86_400_000))
    const row = byDay.get(key)
    series.push({
      day: key,
      inbound: (row?.inboundComments ?? 0) + (row?.inboundMessages ?? 0),
      auto: row?.autoSent ?? 0,
      approved: row?.approved ?? 0,
      rejected: row?.rejected ?? 0,
    })
  }
  const maxBar = Math.max(1, ...series.map((s) => s.auto + s.approved + s.rejected))

  const hasData = sent + pending + comments + messages > 0

  return (
    <div className="space-y-7 fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h-page">Analytics</h1>
          <p className="muted mt-1">Last {days} days · how much work the autopilot actually absorbed.</p>
        </div>
        <Badge tone="accent">
          <Icon name="analytics" size={12} /> {agg._count._all} drafts generated
        </Badge>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Replies sent" value={sent} hint={`${autoSent} fully automatic`} tone="good" />
        <Stat label="Automation rate" value={`${autoRate}%`} hint="Share sent with no human touch" tone={autoRate >= 60 ? 'good' : autoRate >= 25 ? 'warn' : 'neutral'} />
        <Stat label="Approval rate" value={`${approvalRate}%`} hint="Drafts you approved vs rejected" tone={approvalRate >= 80 ? 'good' : 'warn'} />
        <Stat label="Avg confidence" value={`${avgConfidence}%`} hint={`$${totalCost} AI spend · ${pending} pending`} tone="accent" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Comments ingested" value={comments} hint="Across all profiles" />
        <Stat label="Inbound DMs" value={messages} hint="Conversations received" />
        <Stat label="Rejected drafts" value={rejected} hint="Rejected → tune the voice or knowledge base" tone={rejected > sent * 0.3 ? 'bad' : 'neutral'} />
        <Stat label="Profiles" value={accounts.length} hint="Connected and reporting" />
      </div>

      {!hasData ? (
        <EmptyState
          title="No data yet"
          description="Once comments and DMs start flowing, this page shows automation rate, per-profile volume and what people are actually asking about."
          icon={<Icon name="analytics" size={22} />}
        />
      ) : (
        <>
          <section className="card-pad">
            <h2 className="text-sm font-semibold text-white">Replies per day</h2>
            <p className="muted mt-1 text-xs">Green = auto-sent · Blue = approved by you · Red = rejected</p>
            <div className="mt-5 flex h-40 items-end gap-1.5">
              {series.map((s) => {
                const total = s.auto + s.approved + s.rejected
                const h = total ? Math.max(4, (total / maxBar) * 100) : 2
                return (
                  <div key={s.day} className="group relative flex flex-1 flex-col justify-end">
                    <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: `${h}%` }}>
                      {s.rejected ? <div className="w-full bg-rose-400/70" style={{ height: `${(s.rejected / total) * 100}%` }} /> : null}
                      {s.approved ? <div className="w-full bg-accent-500/80" style={{ height: `${(s.approved / total) * 100}%` }} /> : null}
                      {s.auto ? <div className="w-full bg-mint-500/80" style={{ height: `${(s.auto / total) * 100}%` }} /> : null}
                    </div>
                    <div className="pointer-events-none absolute -top-9 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-[10px] text-mist-200 shadow-xl group-hover:block">
                      {s.day}: {total} sent · {s.inbound} inbound
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-mist-400">
              <span>{series[0]?.day}</span>
              <span>{series[series.length - 1]?.day}</span>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card-pad">
              <h2 className="text-sm font-semibold text-white">What people are asking</h2>
              <p className="muted mt-1 text-xs">Detected intents — use this to grow the knowledge base.</p>
              <div className="mt-4 space-y-2.5">
                {intents.length === 0 ? (
                  <p className="text-xs text-mist-400">No drafts generated in this window yet.</p>
                ) : (
                  intents.map((i) => {
                    const max = Math.max(...intents.map((x) => x._count._all))
                    return (
                      <div key={i.intent ?? 'other'}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-mist-200">{(i.intent ?? 'other').replace(/_/g, ' ')}</span>
                          <span className="font-mono text-mist-400">{i._count._all}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800">
                          <div className="h-full rounded-full bg-accent-500/70" style={{ width: `${(i._count._all / max) * 100}%` }} />
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>

            <section className="card-pad">
              <h2 className="text-sm font-semibold text-white">Per profile</h2>
              <div className="mt-4 space-y-3">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-3">
                    <PlatformIcon platform={a.platform} size={16} className="shrink-0 text-mist-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-mist-100">{a.name}</div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800">
                        <div
                          className="h-full rounded-full bg-mint-500/70"
                          style={{ width: `${Math.min(100, ((sentByAccount.get(a.id) ?? 0) / Math.max(1, sent)) * 100)}%` }}
                        />
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono text-[11px] text-mist-400">
                      <div>{sentByAccount.get(a.id) ?? 0} sent</div>
                      <div>{a._count.comments} comments</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}

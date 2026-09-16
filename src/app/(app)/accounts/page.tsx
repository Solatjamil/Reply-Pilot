import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { EmptyState } from '@/components/ui'
import { Icon } from '@/components/icons'
import { ConnectButton } from '@/components/connect-button'
import { AccountRow, type AccountRowData } from '@/components/account-row'
import { PLATFORM_LIST, type PlatformCapabilities } from '@/lib/platforms/catalog'
import { configuredPlatforms, env } from '@/lib/env'

export const dynamic = 'force-dynamic'

const MISSING_LABEL: Record<string, string> = {
  meta: 'Add META_APP_ID + META_APP_SECRET to .env',
  google: 'Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to .env',
  linkedin: 'Add LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET to .env',
  x: 'Add X_CLIENT_ID + X_CLIENT_SECRET to .env',
  tiktok: 'Add TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET to .env',
}

const PROVIDER_FOR_PLATFORM: Record<string, string> = {
  facebook_page: 'meta',
  instagram: 'meta',
  messenger: 'meta',
  youtube: 'google',
  linkedin_org: 'linkedin',
  linkedin_person: 'linkedin',
  x: 'x',
  tiktok: 'tiktok',
}

// Instagram and Messenger arrive from the same Meta login as the Facebook Page,
// so only one Meta tile is shown; the picker lists every profile it returns.
const TILE_PLATFORMS = ['facebook_page', 'instagram', 'youtube', 'x', 'linkedin_org', 'tiktok']

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const session = await getSession()
  if (!session) return null
  const params = await searchParams

  const rows = await prisma.account.findMany({
    where: { workspaceId: session.wid },
    orderBy: { connectedAt: 'desc' },
    include: { automation: true, _count: { select: { comments: true, drafts: true } } },
  })

  const pendingCounts = await prisma.draft.groupBy({
    by: ['accountId'],
    where: { workspaceId: session.wid, status: 'pending' },
    _count: { _all: true },
  })
  const pendingMap = new Map(pendingCounts.map((p) => [p.accountId, p._count._all]))

  const accounts: AccountRowData[] = rows.map((a) => ({
    id: a.id,
    platform: a.platform,
    name: a.name,
    handle: a.handle,
    avatarUrl: a.avatarUrl,
    profileUrl: a.profileUrl,
    status: a.status,
    lastError: a.lastError,
    lastSyncAt: a.lastSyncAt,
    connectedAt: a.connectedAt,
    expiresAt: a.expiresAt,
    tokenPreview: '',
    capabilities: safeCaps(a.capabilities),
    automation: a.automation
      ? {
          replyToComments: a.automation.replyToComments,
          replyToDms: a.automation.replyToDms,
          autoSendEnabled: a.automation.autoSendEnabled,
          autoSendThreshold: a.automation.autoSendThreshold,
        }
      : null,
    stats: { comments: a._count.comments, drafts: a._count.drafts, pending: pendingMap.get(a.id) ?? 0 },
  }))

  const configured = Object.fromEntries(configuredPlatforms().map((p) => [p.id, p.ok]))

  return (
    <div className="space-y-8 fade-in">
      <header>
        <h1 className="h-page">Connected profiles</h1>
        <p className="muted mt-1">
          Click a platform, approve the permissions, then tick the pages and profiles you want ReplyPilot to answer for.
        </p>
      </header>

      {params.error ? (
        <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/8 p-4">
          <span className="mt-0.5 text-rose-400"><Icon name="warning" size={18} /></span>
          <div className="flex-1 text-sm text-rose-400/90">{params.error}</div>
          <Link href="/accounts" className="btn-ghost btn-sm shrink-0">Dismiss</Link>
        </div>
      ) : null}

      {params.ok === 'connected' ? (
        <div className="flex items-center gap-3 rounded-xl border border-mint-500/30 bg-mint-500/8 p-4 text-sm text-mint-400">
          <Icon name="check" size={18} /> Profile attached. The first sync is already queued — comments and DMs will start appearing shortly.
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Your profiles</h2>
        {accounts.length === 0 ? (
          <EmptyState
            title="No profiles attached yet"
            description="Pick a platform below. ReplyPilot only asks for the permissions it needs to read and answer comments and DMs on your behalf."
            icon={<Icon name="accounts" size={22} />}
          />
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Attach a new profile</h2>
          <Link href="/settings#platform-access" className="text-xs text-accent-400 hover:underline">Where do I get these keys? →</Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {TILE_PLATFORMS.map((id) => {
            const platform = PLATFORM_LIST.find((p) => p.id === id)
            if (!platform) return null
            const provider = PROVIDER_FOR_PLATFORM[id]
            return (
              <ConnectButton
                key={id}
                platform={platform}
                configured={Boolean(configured[provider])}
                missingLabel={MISSING_LABEL[provider] ?? 'Add credentials to .env'}
              />
            )
          })}
        </div>
        <p className="text-xs text-mist-400">
          Connecting Meta returns your Facebook Pages, each Page&apos;s Messenger inbox and every linked Instagram professional account in one
          approval — you tick the ones you want on the next screen.
        </p>
      </section>

      <section className="card-pad">
        <h3 className="text-sm font-semibold text-white">Webhook endpoints</h3>
        <p className="muted mt-1 text-xs">
          Paste these into each platform&apos;s developer console. Polling runs automatically as a fallback for platforms without webhooks
          (YouTube, X on lower tiers, LinkedIn).
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ['Meta (Pages, Instagram, Messenger)', '/api/webhooks/meta'],
            ['TikTok Business Messaging', '/api/webhooks/tiktok'],
            ['X Account Activity', '/api/webhooks/x'],
            ['LinkedIn', '/api/webhooks/linkedin'],
          ].map(([label, path]) => (
            <div key={path} className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              <span className="truncate text-xs text-mist-300">{label}</span>
              <code className="shrink-0 font-mono text-[11px] text-accent-400">{env.appUrl}{path}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function safeCaps(raw: string | null): PlatformCapabilities {
  try {
    return raw ? (JSON.parse(raw) as PlatformCapabilities) : ({} as PlatformCapabilities)
  } catch {
    return {} as PlatformCapabilities
  }
}

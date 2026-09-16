import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { aiConfigured, configuredPlatforms, env } from '@/lib/env'
import { mockProviderEnabled } from '@/lib/ai/mock-provider'
import { databaseProvider } from '@/lib/db/adapter'
import { Badge } from '@/components/ui'
import { Icon } from '@/components/icons'
import { CopyRow, XWebhookButton } from '@/components/settings-client'

export const dynamic = 'force-dynamic'

const ENV_KEYS: Record<string, string[]> = {
  meta: ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_API_KEY', 'X_API_KEY_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
}

const CONSOLE_LINKS: Record<string, { label: string; href: string }> = {
  meta: { label: 'developers.facebook.com', href: 'https://developers.facebook.com/apps' },
  google: { label: 'console.cloud.google.com', href: 'https://console.cloud.google.com/apis/credentials' },
  linkedin: { label: 'linkedin.com/developers', href: 'https://www.linkedin.com/developers/apps' },
  x: { label: 'developer.x.com', href: 'https://developer.x.com/en/portal/dashboard' },
  tiktok: { label: 'developers.tiktok.com', href: 'https://developers.tiktok.com/apps' },
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession()
  if (!session) return null
  const params = await searchParams

  const [accounts, counts] = await Promise.all([
    prisma.account.findMany({ where: { workspaceId: session.wid }, orderBy: { connectedAt: 'desc' } }),
    prisma.$transaction([
      prisma.comment.count({ where: { workspaceId: session.wid } }),
      prisma.message.count({ where: { workspaceId: session.wid } }),
      prisma.draft.count({ where: { workspaceId: session.wid } }),
      prisma.knowledgeItem.count({ where: { workspaceId: session.wid } }),
    ]),
  ])

  const platforms = configuredPlatforms()
  const ai = aiConfigured()
  const mock = mockProviderEnabled()
  const insecureSecret = env.appSecret.startsWith('change-me') || env.authSecret.startsWith('change-me')
  const localAppUrl = env.appUrl.includes('localhost') || env.appUrl.includes('127.0.0.1')
  const xAccounts = accounts.filter((a) => a.platform === 'x')

  return (
    <div className="space-y-8 fade-in">
      <header>
        <h1 className="h-page">Settings</h1>
        <p className="muted mt-1">Credentials, webhook endpoints, and the exact API access each platform requires before automation works.</p>
      </header>

      {params.error ? (
        <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/8 p-4 text-sm text-rose-400">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0" />
          <span>{params.error}</span>
        </div>
      ) : null}

      {params.error ? (
        <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/8 p-4">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-rose-400" />
          <div className="flex-1 text-sm leading-relaxed text-rose-400/90">{params.error}</div>
          <Link href="/settings" className="btn-ghost btn-sm shrink-0">
            Dismiss
          </Link>
        </div>
      ) : null}

      {insecureSecret ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-400/8 p-4">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-xs leading-relaxed text-amber-400/90">
            <span className="font-semibold">Default secrets in use.</span> Set <code className="font-mono">APP_SECRET</code> and{' '}
            <code className="font-mono">AUTH_SECRET</code> to long random strings before deploying.{' '}
            <code className="font-mono">APP_SECRET</code> encrypts every stored OAuth token — changing it later forces all profiles to be
            reconnected.
          </div>
        </div>
      ) : null}

      {/* ── Runtime status ── */}
      {mock ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <strong className="font-semibold">Mock AI mode is on.</strong> Every generated reply is produced by a
          deterministic local stand-in and prefixed <code className="font-mono">[MOCK]</code> — no LLM is being
          called and nothing costs anything. Set <code className="font-mono">{`AI_MOCK="0"`}</code> in <code className="font-mono">.env</code> alongside a
          real provider key, then restart, to generate with a real model.
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Runtime</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="card-pad">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-mist-400">AI provider</span>
              <Badge tone={mock ? 'warn' : ai ? 'good' : 'bad'}>{mock ? 'mock mode' : ai ? 'ready' : 'no key'}</Badge>
            </div>
            <div className="mt-2 text-sm font-medium text-white">{mock ? 'mock (AI_MOCK=1)' : env.ai.provider}</div>
            <div className="font-mono text-[11px] text-mist-400">{mock ? 'replypilot-mock-1 — deterministic, no cost' : env.ai.model}</div>
          </div>
          <div className="card-pad">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-mist-400">Database</span>
              <Badge tone={databaseProvider() === 'postgresql' ? 'good' : 'warn'}>{databaseProvider()}</Badge>
            </div>
            <div className="mt-2 text-sm font-medium text-white">
              {counts[0]} comments · {counts[1]} messages
            </div>
            <div className="font-mono text-[11px] text-mist-400">
              {counts[2]} drafts · {counts[3]} knowledge entries
            </div>
          </div>
          <div className="card-pad">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-mist-400">Public URL</span>
              <Badge tone={localAppUrl ? 'warn' : 'good'}>{localAppUrl ? 'local' : 'public'}</Badge>
            </div>
            <div className="mt-2 truncate font-mono text-[11px] text-white">{env.appUrl}</div>
            {localAppUrl ? <div className="mt-1 text-[10px] leading-relaxed text-amber-400/80">Webhooks need a public HTTPS URL — use a tunnel for local testing.</div> : null}
          </div>
        </div>
      </section>

      {/* ── Webhook endpoints ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Webhook endpoints</h2>
        <p className="muted text-xs">
          Paste these into each developer console. Meta&apos;s verify token is <code className="font-mono text-mist-300">{env.meta.verifyToken}</code>;
          TikTok&apos;s is <code className="font-mono text-mist-300">{env.tiktok.verifyToken}</code>. Webhooks must respond in under 5 seconds —
          ReplyPilot ACKs immediately and processes in the background queue.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <CopyRow label="Meta (Pages · Instagram · Messenger)" value={`${env.appUrl}/api/webhooks/meta`} hint="Subscribe: feed, comments, mentions, messaging, message_echoes" />
          <CopyRow label="TikTok Business Messaging" value={`${env.appUrl}/api/webhooks/tiktok`} />
          <CopyRow label="X Account Activity" value={`${env.appUrl}/api/webhooks/x`} hint="Or click the button below to auto-register it" />
          <CopyRow label="LinkedIn" value={`${env.appUrl}/api/webhooks/linkedin`} hint="Polling is used unless your app has partner webhook access" />
        </div>
        {xAccounts.length ? (
          <div className="card-pad space-y-2">
            <div className="text-xs font-medium text-mist-200">Register X Account Activity for a connected account</div>
            {xAccounts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-mist-400">{a.name}</span>
                <XWebhookButton accountId={a.id} />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ── Platform credentials ── */}
      <section id="platform-access" className="space-y-3 scroll-mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Platform credentials</h2>
        <div className="card divide-y divide-ink-800">
          {platforms.map((p) => (
            <div key={p.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Badge tone={p.ok ? 'good' : 'warn'}>{p.ok ? 'configured' : 'missing'}</Badge>
                  <span className="text-sm font-medium text-white">{p.label}</span>
                </div>
                {CONSOLE_LINKS[p.id] ? (
                  <a href={CONSOLE_LINKS[p.id].href} target="_blank" rel="noreferrer noopener" className="text-xs text-accent-400 hover:underline">
                    {CONSOLE_LINKS[p.id].label} →
                  </a>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(ENV_KEYS[p.id] ?? []).map((k) => (
                  <code key={k} className="rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">
                    {k}
                  </code>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Access requirements per platform ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">What each platform actually allows</h2>
        <p className="muted text-xs">
          This is the part that decides whether automation works. It is enforced by the platforms, not by ReplyPilot — details and sources in{' '}
          <code className="font-mono text-mist-300">docs/API_REFERENCE.md</code>.
        </p>
        <div className="space-y-3">
          {ACCESS_NOTES.map((n) => (
            <div key={n.platform} className="card-pad">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-white">{n.platform}</span>
                <Badge tone={n.tone}>{n.verdict}</Badge>
              </div>
              <ul className="mt-2.5 space-y-1.5">
                {n.points.map((pt) => (
                  <li key={pt} className="flex gap-2 text-xs leading-relaxed text-mist-300">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-mist-400" />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── Connected profiles ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Connected profiles</h2>
        {accounts.length === 0 ? (
          <div className="card-pad text-sm text-mist-400">
            None yet. <Link href="/accounts" className="text-accent-400 hover:underline">Attach a profile →</Link>
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-mist-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Profile</th>
                  <th className="px-4 py-2.5 font-medium">Platform</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Token expires</th>
                  <th className="px-4 py-2.5 font-medium">Connected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2.5 text-mist-100">{a.name}</td>
                    <td className="px-4 py-2.5 font-mono text-mist-400">{a.platform}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={a.status === 'active' ? 'good' : a.status === 'error' ? 'bad' : 'warn'}>{a.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-mist-400">{a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : 'no expiry'}</td>
                    <td className="px-4 py-2.5 text-mist-400">{new Date(a.connectedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Background worker ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">Background worker</h2>
        <div className="card-pad space-y-2 text-xs leading-relaxed text-mist-300">
          <p>
            In-process worker: <Badge tone={env.worker.inProcess ? 'good' : 'warn'}>{env.worker.inProcess ? 'enabled' : 'disabled'}</Badge>{' '}
            · poll every <span className="font-mono">{env.worker.pollIntervalSeconds}s</span> · concurrency{' '}
            <span className="font-mono">{env.worker.concurrency}</span>
          </p>
          <p className="text-mist-400">
            On a single server this is all you need. On serverless (Vercel) set <code className="font-mono">ENABLE_INPROC_WORKER=0</code>, run{' '}
            <code className="font-mono">npm run worker</code> as a separate process, and add a cron hitting{' '}
            <code className="font-mono">/api/jobs/run</code> (set <code className="font-mono">CRON_SECRET</code> to call it unauthenticated).
          </p>
          <form action="/api/jobs/run" method="post">
            <button type="submit" className="btn-ghost btn-sm mt-1">
              <Icon name="refresh" size={13} /> Run queue now
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}

const ACCESS_NOTES = [
  {
    platform: 'Facebook Pages · Instagram · Messenger',
    verdict: 'full automation available',
    tone: 'good' as const,
    points: [
      'Requires a Facebook App with App Review approval for pages_messaging, pages_manage_metadata, instagram_manage_comments and instagram_manage_messages. Development Mode only works for app admins/testers.',
      'Instagram must be a Business or Creator profile, linked to a Facebook Page (or use Instagram Login with the Instagram API).',
      'Comment replies: POST /{comment-id}/replies (IG) and /{comment-id}/comments (Page). Public replies are unlimited by policy but rate-limited (~200 calls/hour per user on the Page API, 4800 × impressions/24h overall).',
      'Comment → DM ("private reply"): allowed once per comment, within 7 days of the comment. This is the mechanism behind every "comment LINK and I\'ll DM you" funnel.',
      'DMs: free-form messages only inside the 24-hour window after the user\'s last message; a human agent may extend to 7 days with the HUMAN_AGENT tag. Cold outreach is not permitted at all.',
      'Webhooks: Page feed/comments/mentions + messaging. Must ACK with 200 in under 5 seconds.',
    ],
  },
  {
    platform: 'YouTube',
    verdict: 'comments yes · DMs impossible',
    tone: 'warn' as const,
    points: [
      'Comment read + reply works with youtube.force-ssl on the channel owner\'s OAuth token. Replies can only be attached to top-level comments.',
      'There is no comment webhook — ReplyPilot polls recent uploads, then commentThreads per video.',
      'YouTube has no public DM API. DM automation cannot be built for YouTube by anyone.',
      'Default quota is 10,000 units/day; commentThreads.list costs 1 unit and commentThreads.insert 50. Request a quota increase in the Cloud console for busy channels.',
      'Your Google OAuth consent screen must be verified (or the token will be limited to test users).',
    ],
  },
  {
    platform: 'X (Twitter)',
    verdict: 'works on a paid tier',
    tone: 'warn' as const,
    points: [
      'Replies are just POST /2/tweets with reply.in_reply_to_tweet_id — 280 character limit.',
      'There is no "list comments on my post" endpoint on lower tiers; ReplyPilot reads GET /2/users/:id/mentions plus (when available) search/recent filtered by conversation_id.',
      'Real-time delivery needs the Account Activity API (webhooks), which is only on paid X tiers. Without it, ingestion is polling — expect a delay of one poll interval.',
      'DM read/write needs dm.read + dm.write and an existing conversation; X does not allow cold DMs.',
      'The free tier is effectively write-only with near-zero reads, which is not usable for this product. Budget for Basic/Pro or pay-per-use.',
    ],
  },
  {
    platform: 'LinkedIn',
    verdict: 'comments gated · DMs partner-only',
    tone: 'warn' as const,
    points: [
      'Company-page comments: GET/POST https://api.linkedin.com/rest/socialActions/{urn}/comments with Linkedin-Version + X-Restli-Protocol-Version headers.',
      'Your LinkedIn app must be granted Community Management API access, with r_organization_social and w_organization_social.',
      'r_member_social (personal-profile comment reads) is a closed permission — LinkedIn is not accepting access requests, so personal profiles can post replies but may not be able to read comments.',
      'Only comments on posts your own page authored are readable. There is no firehose.',
      'Messaging/DM automation requires the separate Messaging API partner program for Business Accounts. It is not available to normal apps, so DMs are disabled for LinkedIn.',
      'Access tokens last 60 days with no refresh token — profiles must be reconnected periodically (ReplyPilot flags this before it breaks).',
    ],
  },
  {
    platform: 'TikTok',
    verdict: 'partner-gated',
    tone: 'bad' as const,
    points: [
      'The public Display / Content Posting APIs expose no comment read, comment reply or DM endpoints. Those live in the Business Messaging API.',
      'Business Messaging is in Open Beta and granted per-app by TikTok. The account must also be a TikTok Business Account linked to TikTok for Business / Business Center to get Advanced Access — otherwise the API returns "Only Business account can use Message API".',
      'DM automation is unavailable for accounts registered in the EEA, Switzerland, the UK and India. Businesses cannot initiate DMs: reply-only inside a 48-hour, 10-consecutive-message window.',
      'Comment-triggered DMs are only rolled out in a few markets — this is a TikTok-side gate, not a tool limitation.',
      'Until access is granted, ReplyPilot keeps TikTok connected in read-only mode (videos + comment counts) and surfaces this state on the profile card. Set TIKTOK_BUSINESS_MESSAGING=1 plus your partner endpoint paths once approved.',
      'Any tool that automates TikTok by driving a logged-in browser session violates TikTok\'s Integrity and Authenticity rules and risks the account. ReplyPilot does not do that.',
    ],
  },
]

import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { AutomationsClient } from '@/components/automations-client'

export const dynamic = 'force-dynamic'

function safeJson(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export default async function AutomationsPage() {
  const session = await getSession()
  if (!session) return null

  const [accounts, automations, voices] = await Promise.all([
    prisma.account.findMany({ where: { workspaceId: session.wid }, orderBy: { name: 'asc' } }),
    prisma.automationConfig.findMany({ where: { workspaceId: session.wid } }),
    prisma.brandVoice.findMany({ where: { workspaceId: session.wid }, orderBy: { name: 'asc' } }),
  ])

  const DEFAULTS = {
    replyToComments: true,
    replyToDms: true,
    replyToMentions: true,
    autoSendEnabled: true,
    autoSendThreshold: 0.82,
    reviewThreshold: 0.55,
    minDelaySeconds: 20,
    maxDelaySeconds: 180,
    maxAutoPerHour: 25,
    maxAutoPerDay: 400,
    maxRepliesPerUser: 2,
    skipOwnComments: true,
    skipRepliesToUs: true,
    skipLowEffort: true,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    timezone: 'UTC',
    language: 'auto',
    brandVoiceId: null,
  }

  const rows = accounts.map((a) => {
    const found = automations.find((x) => x.accountId === a.id)
    return {
      accountId: a.id,
      ...DEFAULTS,
      ...(found
        ? {
            replyToComments: found.replyToComments,
            replyToDms: found.replyToDms,
            replyToMentions: found.replyToMentions,
            autoSendEnabled: found.autoSendEnabled,
            autoSendThreshold: found.autoSendThreshold,
            reviewThreshold: found.reviewThreshold,
            minDelaySeconds: found.minDelaySeconds,
            maxDelaySeconds: found.maxDelaySeconds,
            maxAutoPerHour: found.maxAutoPerHour,
            maxAutoPerDay: found.maxAutoPerDay,
            maxRepliesPerUser: found.maxRepliesPerUser,
            skipOwnComments: found.skipOwnComments,
            skipRepliesToUs: found.skipRepliesToUs,
            skipLowEffort: found.skipLowEffort,
            quietHoursEnabled: found.quietHoursEnabled,
            quietHoursStart: found.quietHoursStart,
            quietHoursEnd: found.quietHoursEnd,
            timezone: found.timezone,
            language: found.language,
            brandVoiceId: found.brandVoiceId,
          }
        : {}),
    }
  })

  return (
    <div className="space-y-6 fade-in">
      <header>
        <h1 className="h-page">Automation rules</h1>
        <p className="muted mt-1">
          Per-profile control over what gets answered, how sure the AI has to be before it posts on its own, and the guards that keep you
          inside platform anti-spam rules.
        </p>
      </header>
      <AutomationsClient
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          platform: a.platform,
          handle: a.handle,
          capabilities: safeJson(a.capabilities),
        }))}
        automations={rows}
        voices={voices.map((v) => ({ id: v.id, name: v.name }))}
      />
    </div>
  )
}

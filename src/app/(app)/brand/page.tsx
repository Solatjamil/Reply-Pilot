import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { BrandVoiceClient, type VoiceData } from '@/components/brand-voice-client'

export const dynamic = 'force-dynamic'

function parse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export default async function BrandPage() {
  const session = await getSession()
  if (!session) return null

  const [voices, accounts] = await Promise.all([
    prisma.brandVoice.findMany({ where: { workspaceId: session.wid }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
    prisma.account.findMany({ where: { workspaceId: session.wid }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])

  const data: VoiceData[] = voices.map((v) => ({
    id: v.id,
    name: v.name,
    persona: v.persona,
    tone: v.tone,
    language: v.language,
    emojiPolicy: v.emojiPolicy,
    signOff: v.signOff,
    bannedWords: parse<string[]>(v.bannedWords, []),
    mustInclude: parse<string[]>(v.mustInclude, []),
    maxChars: v.maxChars,
    examples: parse<{ comment: string; reply: string }[]>(v.examples, []),
    isDefault: v.isDefault,
  }))

  return (
    <div className="space-y-6 fade-in">
      <header>
        <h1 className="h-page">Brand voice</h1>
        <p className="muted mt-1">
          This is what makes replies sound like you instead of a chatbot. The persona text is injected into every generation, and the
          playground on the right runs the real engine without posting anything.
        </p>
      </header>
      <BrandVoiceClient voices={data} accounts={accounts} />
    </div>
  )
}

import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { aiConfigured, env } from '@/lib/env'
import { KnowledgeClient } from '@/components/knowledge-client'

export const dynamic = 'force-dynamic'

export default async function KnowledgePage() {
  const session = await getSession()
  if (!session) return null

  const [items, rules, accounts] = await Promise.all([
    prisma.knowledgeItem.findMany({ where: { workspaceId: session.wid }, orderBy: { updatedAt: 'desc' }, take: 300 }),
    prisma.safetyRule.findMany({
      where: { workspaceId: session.wid },
      orderBy: [{ kind: 'asc' }, { priority: 'asc' }],
      include: { account: { select: { id: true, name: true, platform: true } } },
    }),
    prisma.account.findMany({ where: { workspaceId: session.wid }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])

  return (
    <div className="space-y-6 fade-in">
      <header>
        <h1 className="h-page">Knowledge base &amp; safety rules</h1>
        <p className="muted mt-1">
          The AI may only state facts it finds here. Everything else gets escalated to a human instead of guessed.
        </p>
      </header>
      <KnowledgeClient
        items={items.map((i) => ({ ...i, tags: i.tags, updatedAt: i.updatedAt.toISOString() }))}
        rules={rules}
        accounts={accounts}
        aiReady={aiConfigured()}
        embedProvider={process.env.OPENAI_API_KEY ? 'openai' : process.env.GOOGLE_API_KEY ? 'google' : env.ai.provider === 'ollama' ? 'ollama' : null}
      />
    </div>
  )
}

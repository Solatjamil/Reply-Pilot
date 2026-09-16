
import { prisma } from '@/lib/db'
import { chat, cosineSimilarity, embed } from './llm'

export interface RetrievedItem {
  id: string
  title: string
  question?: string | null
  body: string
  url?: string | null
  score: number
  kind: string
}

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those is are was were be been being do does did doing have has had having i you he she it we they me him her us them my your his its our their what which who whom when where why how all any both each few more most other some such no nor not only own same so too very can will just don should now'.split(
    ' ',
  ),
)

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function lexicalScore(queryTokens: string[], docTokens: string[]): number {
  if (!queryTokens.length || !docTokens.length) return 0
  const docSet = new Set(docTokens)
  let hits = 0
  for (const t of new Set(queryTokens)) if (docSet.has(t)) hits++
  const coverage = hits / new Set(queryTokens).size
  // Reward exact phrase overlap lightly
  return coverage * (1 + hits / docTokens.length)
}

/**
 * Hybrid retrieval: cosine similarity over stored embeddings when available,
 * always blended with lexical overlap so it still works with zero config.
 */
export async function retrieveKnowledge(
  workspaceId: string,
  query: string,
  opts: { limit?: number; minScore?: number } = {},
): Promise<RetrievedItem[]> {
  const limit = opts.limit ?? 6
  const minScore = opts.minScore ?? 0.08

  const items = await prisma.knowledgeItem.findMany({
    where: { workspaceId, enabled: true },
    take: 500,
  })
  if (items.length === 0) return []

  const queryTokens = tokenize(query)
  let queryEmbedding: number[] | null = null
  if (items.some((i) => i.embedding)) {
    const [emb] = (await embed([query])) ?? []
    queryEmbedding = emb ?? null
  }

  const scored: RetrievedItem[] = items.map((item) => {
    const docText = [item.question ?? '', item.title, item.body, item.tags].join('\n')
    const lexical = lexicalScore(queryTokens, tokenize(docText))

    let semantic = 0
    if (queryEmbedding && item.embedding) {
      try {
        semantic = Math.max(0, cosineSimilarity(queryEmbedding, JSON.parse(item.embedding) as number[]))
      } catch {
        semantic = 0
      }
    }

    const score = (semantic * 0.7 + lexical * 0.55) * (1 + item.weight / 20)
    return {
      id: item.id,
      title: item.title,
      question: item.question,
      body: item.body,
      url: item.url,
      kind: item.kind,
      score: Number(score.toFixed(4)),
    }
  })

  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** Generates embeddings for every knowledge item missing one. */
export async function backfillEmbeddings(workspaceId: string): Promise<{ embedded: number; failed: number }> {
  const items = await prisma.knowledgeItem.findMany({
    where: { workspaceId, embedding: null },
    take: 200,
  })
  if (items.length === 0) return { embedded: 0, failed: 0 }

  const texts = items.map((i) => `${i.question ?? ''}\n${i.title}\n${i.body}`.trim())
  const vectors = await embed(texts)
  if (!vectors) return { embedded: 0, failed: items.length }

  let embedded = 0
  for (let i = 0; i < items.length; i++) {
    const vec = vectors[i]
    if (!vec?.length) continue
    await prisma.knowledgeItem.update({
      where: { id: items[i].id },
      data: { embedding: JSON.stringify(vec), embedModel: process.env.EMBED_MODEL || 'text-embedding-3-small' },
    })
    embedded++
  }
  return { embedded, failed: items.length - embedded }
}

export { chat }

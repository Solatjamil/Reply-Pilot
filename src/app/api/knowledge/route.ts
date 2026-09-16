import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'
import { enqueue } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['faq', 'policy', 'product', 'url', 'doc']).default('faq'),
  title: z.string().min(1).max(200),
  question: z.string().max(500).optional().nullable(),
  body: z.string().min(1).max(20000),
  tags: z.array(z.string()).max(20).optional(),
  url: z.string().max(500).optional().nullable(),
  weight: z.number().int().min(0).max(20).optional(),
  enabled: z.boolean().optional(),
})

async function auth() {
  try {
    return await requireApiSession()
  } catch {
    return null
  }
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const items = await prisma.knowledgeItem.findMany({
    where: { workspaceId: session.wid },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  })
  return NextResponse.json({
    items: items.map((i) => ({ ...i, embedding: i.embedding ? 'embedded' : null })),
  })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const parsed = createSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })

  const { id, tags, ...data } = parsed.data
  const payload = { workspaceId: session.wid, tags: JSON.stringify(tags ?? []), ...data }

  const item = id
    ? await prisma.knowledgeItem.update({
        where: { id },
        data: { ...payload, embedding: null, embedModel: null },
      })
    : await prisma.knowledgeItem.create({ data: payload })

  await enqueue({ type: 'embed_knowledge', workspaceId: session.wid, payload: { workspaceId: session.wid }, key: `embed:${session.wid}`, priority: 2 })

  return NextResponse.json({ ok: true, item })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  await prisma.knowledgeItem.deleteMany({ where: { id, workspaceId: session.wid } })
  return NextResponse.json({ ok: true })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const schema = z.object({
  id: z.string().optional(),
  accountId: z.string().nullable().optional(),
  kind: z.enum(['blocklist', 'escalate_keyword', 'guaranteed_answer', 'competitor', 'profanity']),
  pattern: z.string().min(1).max(200),
  matchType: z.enum(['contains', 'exact', 'regex', 'whole_word']).default('contains'),
  response: z.string().max(2000).nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
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
  const rules = await prisma.safetyRule.findMany({
    where: { workspaceId: session.wid },
    orderBy: [{ kind: 'asc' }, { priority: 'asc' }],
    include: { account: { select: { id: true, name: true, platform: true } } },
  })
  return NextResponse.json({ rules })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })

  const { id, ...data } = parsed.data
  if (data.kind === 'guaranteed_answer' && !data.response?.trim()) {
    return NextResponse.json({ error: 'A guaranteed answer rule needs the answer text.' }, { status: 400 })
  }
  if (data.matchType === 'regex') {
    try {
      new RegExp(data.pattern)
    } catch {
      return NextResponse.json({ error: 'That regular expression is invalid.' }, { status: 400 })
    }
  }

  const rule = id
    ? await prisma.safetyRule.update({ where: { id }, data: { ...data, workspaceId: session.wid } })
    : await prisma.safetyRule.create({ data: { ...data, workspaceId: session.wid } })
  return NextResponse.json({ ok: true, rule })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  await prisma.safetyRule.deleteMany({ where: { id, workspaceId: session.wid } })
  return NextResponse.json({ ok: true })
}

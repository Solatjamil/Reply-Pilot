import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const schema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80).optional(),
  persona: z.string().max(4000).optional(),
  tone: z.string().max(300).optional(),
  language: z.string().max(20).optional(),
  emojiPolicy: z.enum(['none', 'sparingly', 'freely']).optional(),
  signOff: z.string().max(120).nullable().optional(),
  bannedWords: z.array(z.string()).max(200).optional(),
  mustInclude: z.array(z.string()).max(50).optional(),
  maxChars: z.number().int().min(20).max(8000).optional(),
  examples: z.array(z.object({ comment: z.string().max(500), reply: z.string().max(1000) })).max(20).optional(),
  isDefault: z.boolean().optional(),
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
  const voices = await prisma.brandVoice.findMany({ where: { workspaceId: session.wid }, orderBy: { name: 'asc' } })
  return NextResponse.json({
    voices: voices.map((v) => ({ ...v, bannedWords: parse(v.bannedWords), mustInclude: parse(v.mustInclude), examples: parse(v.examples) })),
  })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })

  const { id, bannedWords, mustInclude, examples, isDefault, ...rest } = parsed.data
  const data = {
    ...rest,
    ...(bannedWords ? { bannedWords: JSON.stringify(bannedWords) } : {}),
    ...(mustInclude ? { mustInclude: JSON.stringify(mustInclude) } : {}),
    ...(examples ? { examples: JSON.stringify(examples) } : {}),
    ...(isDefault !== undefined ? { isDefault } : {}),
  }

  if (isDefault) await prisma.brandVoice.updateMany({ where: { workspaceId: session.wid }, data: { isDefault: false } })

  const voice = id
    ? await prisma.brandVoice.update({ where: { id }, data })
    : await prisma.brandVoice.create({
        data: {
          workspaceId: session.wid,
          name: rest.name ?? 'New voice',
          persona: rest.persona ?? 'You are the friendly social media manager for this brand.',
          tone: rest.tone ?? 'friendly, concise, helpful',
          ...data,
        },
      })

  return NextResponse.json({ ok: true, voice })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  await prisma.brandVoice.deleteMany({ where: { id, workspaceId: session.wid, isDefault: false } })
  return NextResponse.json({ ok: true })
}

function parse(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

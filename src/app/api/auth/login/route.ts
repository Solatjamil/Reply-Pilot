import { NextResponse } from 'next/server'
import { createSessionCookie, findOrCreateBootstrapUser, loginWithEmail } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string }
  if (!body.email || !body.password) return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })

  // First-ever run: create the bootstrap admin so the app is usable immediately.
  const userCount = await prisma.user.count()
  if (userCount === 0) {
    const boot = await findOrCreateBootstrapUser()
    if (boot.created) {
      console.log(`[replypilot] bootstrap admin created: ${boot.user.email} / ${process.env.BOOTSTRAP_PASSWORD ?? 'replypilot123'}`)
    }
  }

  const result = await loginWithEmail(body.email, body.password)
  if (!result) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })

  await createSessionCookie(result.session)
  return NextResponse.json({ ok: true, workspace: result.workspace.name })
}

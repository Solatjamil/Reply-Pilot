import { NextResponse } from 'next/server'
import { HttpError, createSessionCookie, signupUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; workspaceName?: string }
  try {
    const result = await signupUser({
      email: body.email ?? '',
      password: body.password ?? '',
      name: body.name,
      workspaceName: body.workspaceName,
    })
    await createSessionCookie(result.session)
    return NextResponse.json({ ok: true, workspace: result.workspace.name })
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}

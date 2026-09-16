
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { passwordHash, passwordVerify, randomToken } from '@/lib/crypto'

export const SESSION_COOKIE = 'rp_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

export interface SessionPayload {
  sub: string
  email: string
  name?: string | null
  wid: string
  role: string
}

function secretKey() {
  return new TextEncoder().encode(env.authSecret.padEnd(32, '0').slice(0, 64))
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(secretKey())
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] })
    if (!payload.sub || !payload.wid) return null
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ''),
      name: (payload.name as string) ?? null,
      wid: String(payload.wid),
      role: String(payload.role ?? 'agent'),
    }
  } catch {
    return null
  }
}

export async function createSessionCookie(payload: SessionPayload) {
  const store = await cookies()
  const token = await signSession(payload)
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export async function destroySessionCookie() {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

/** Returns the session or null. Safe to call from any server context. */
export async function getSession(): Promise<SessionPayload | null> {
  try {
    const store = await cookies()
    const token = store.get(SESSION_COOKIE)?.value
    if (!token) return null
    return await verifySession(token)
  } catch {
    return null
  }
}

/** Server-component guard: redirects to /login when unauthenticated. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession()
  if (!session) redirect('/login')
  const ws = await prisma.workspace.findUnique({ where: { id: session.wid } })
  if (!ws) redirect('/login')
  return session
}

/** Route-handler guard: throws 401 JSON when unauthenticated. */
export async function requireApiSession(): Promise<SessionPayload> {
  const session = await getSession()
  if (!session) throw new HttpError(401, 'Not authenticated')
  return session
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'HttpError'
  }
}

// ───────────────────────────── User bootstrap ─────────────────────────────

export async function findOrCreateBootstrapUser() {
  const existing = await prisma.user.findFirst({ include: { memberships: { include: { workspace: true } } } })
  if (existing?.memberships?.[0]) {
    return { user: existing, workspace: existing.memberships[0].workspace, created: false }
  }

  const email = env.bootstrap.email
  const password = env.bootstrap.password
  const slug = env.bootstrap.workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'

  const user = await prisma.user.create({
    data: {
      email,
      name: 'Owner',
      passwordHash: passwordHash(password),
      role: 'owner',
      memberships: {
        create: {
          role: 'owner',
          workspace: {
            create: {
              name: env.bootstrap.workspace,
              slug: `${slug}-${randomToken(3)}`,
              settings: JSON.stringify({}),
            },
          },
        },
      },
    },
    include: { memberships: { include: { workspace: true } } },
  })

  return { user, workspace: user.memberships[0].workspace, created: true }
}

export async function loginWithEmail(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { memberships: { include: { workspace: true } } },
  })
  if (!user || !passwordVerify(password, user.passwordHash)) return null
  const membership = user.memberships[0]
  if (!membership) return null
  return {
    user,
    workspace: membership.workspace,
    session: { sub: user.id, email: user.email, name: user.name, wid: membership.workspaceId, role: membership.role } satisfies SessionPayload,
  }
}

export async function signupUser(input: { email: string; password: string; name?: string; workspaceName?: string }) {
  const email = input.email.toLowerCase().trim()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw new HttpError(409, 'An account with that email already exists')
  if ((input.password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters')

  const wsName = input.workspaceName?.trim() || `${email.split('@')[0]}'s workspace`
  const slug = `${wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ws'}-${randomToken(3)}`

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      passwordHash: passwordHash(input.password),
      role: 'owner',
      memberships: { create: { role: 'owner', workspace: { create: { name: wsName, slug } } } },
    },
    include: { memberships: { include: { workspace: true } } },
  })
  const workspace = user.memberships[0].workspace

  // Every new workspace starts with a usable default brand voice so the AI
  // engine works before the user configures anything.
  await prisma.brandVoice.create({
    data: {
      workspaceId: workspace.id,
      name: 'Default',
      persona:
        'You are the friendly social media manager for this brand. You answer customers accurately, warmly and briefly, using only facts present in the knowledge base or the post itself.',
      tone: 'friendly, concise, helpful',
      isDefault: true,
    },
  })

  return { user, workspace, session: { sub: user.id, email, name: user.name, wid: workspace.id, role: 'owner' } satisfies SessionPayload }
}

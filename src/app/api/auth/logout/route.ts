import { NextResponse } from 'next/server'
import { destroySessionCookie } from '@/lib/auth'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export async function POST() {
  await destroySessionCookie()
  return NextResponse.redirect(`${env.appUrl}/login`, 303)
}

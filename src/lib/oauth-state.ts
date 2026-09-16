import { SignJWT, jwtVerify } from 'jose'
import { env } from '@/lib/env'

export interface OAuthStatePayload {
  wid: string
  uid: string
  provider: string
  nonce: string
}

function key() {
  return new TextEncoder().encode(env.authSecret.padEnd(32, '0').slice(0, 64))
}

/** Signed, tamper-proof OAuth `state` (10 minute TTL). */
export async function signOAuthState(payload: OAuthStatePayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(key())
}

export async function verifyOAuthState(state: string): Promise<OAuthStatePayload | null> {
  try {
    const { payload } = await jwtVerify(state, key(), { algorithms: ['HS256'] })
    if (!payload.wid || !payload.provider) return null
    return {
      wid: String(payload.wid),
      uid: String(payload.uid ?? ''),
      provider: String(payload.provider),
      nonce: String(payload.nonce ?? ''),
    }
  } catch {
    return null
  }
}

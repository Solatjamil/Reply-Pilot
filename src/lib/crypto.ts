
import crypto from 'crypto'

/**
 * All third-party OAuth material is encrypted at rest with AES-256-GCM.
 * The key is derived from APP_SECRET with HKDF so rotating APP_SECRET
 * invalidates stored tokens cleanly (accounts must be reconnected).
 */

const VERSION = 'v1'

function deriveKey(): Buffer {
  const secret = process.env.APP_SECRET
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_SECRET must be set to at least 16 characters in production')
    }
  }
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret || 'replypilot-dev-secret'), Buffer.from('replypilot'), Buffer.from('token-encryption'), 32),
  )
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) cachedKey = deriveKey()
  return cachedKey
}

export function encrypt(plaintext: string): string {
  if (plaintext == null) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return ''
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    // Not encrypted by us — treat as a legacy/plaintext value.
    return payload
  }
  try {
    const [, ivB64, tagB64, dataB64] = parts
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Failed to decrypt stored credential — has APP_SECRET changed since this account was connected?')
  }
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value ?? null))
}

export function decryptJson<T = unknown>(payload: string | null | undefined): T | null {
  const raw = decrypt(payload)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Redacts a token for logs / UI display. */
export function maskToken(token?: string | null): string {
  if (!token) return ''
  if (token.length <= 10) return '••••'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export function hmacSha256(secret: string, data: string | Buffer, encoding: crypto.BinaryToTextEncoding = 'hex'): string {
  return crypto.createHmac('sha256', secret).update(data).digest(encoding)
}

/** Constant-time comparison used for webhook signature checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function passwordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function passwordVerify(password: string, stored: string): boolean {
  const [scheme, salt, hash] = String(stored).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
  return safeEqual(candidate, hash)
}

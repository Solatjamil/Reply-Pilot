

export class ApiError extends Error {
  status: number
  body: unknown
  code?: string | number
  retryable: boolean

  constructor(message: string, opts: { status?: number; body?: unknown; code?: string | number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = opts.status ?? 0
    this.body = opts.body
    this.code = opts.code
    const status = opts.status ?? 0
    this.retryable = opts.retryable ?? (status === 429 || (status >= 500 && status < 600))
  }
}

/**
 * Small in-memory token-bucket limiter, keyed by scope. Each connected account
 * gets its own bucket per endpoint class so a burst on one page can't starve
 * another. In a multi-instance deployment swap this for a Redis-backed limiter
 * (see docs/DEPLOYMENT.md).
 */
class TokenBucket {
  private buckets = new Map<string, { tokens: number; last: number }>()

  constructor(private ratePerSec: number, private burst: number) {}

  /** Resolves once a token is available (or immediately if one is free). */
  async take(scope: string, maxWaitMs = 20_000): Promise<void> {
    const now = Date.now()
    const b = this.buckets.get(scope) ?? { tokens: this.burst, last: now }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.last) / 1000) * this.ratePerSec)
    b.last = now
    if (b.tokens >= 1) {
      b.tokens -= 1
      this.buckets.set(scope, b)
      return
    }
    this.buckets.set(scope, b)
    const waitMs = Math.ceil(((1 - b.tokens) / this.ratePerSec) * 1000)
    if (waitMs > maxWaitMs) throw new ApiError(`Rate limit wait too long (${waitMs}ms) for ${scope}`, { status: 429 })
    await sleep(Math.min(waitMs, maxWaitMs))
    return this.take(scope, maxWaitMs)
  }
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

const globalBucket = new TokenBucket(40, 80)
const perAccountBuckets = new Map<string, TokenBucket>()

export function limiterFor(key: string, ratePerSec: number, burst: number): TokenBucket {
  let b = perAccountBuckets.get(key)
  if (!b) {
    b = new TokenBucket(ratePerSec, burst)
    perAccountBuckets.set(key, b)
  }
  return b
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined | null>
  json?: unknown
  form?: Record<string, string>
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  /** Bucket scope for the per-account limiter, e.g. `meta:pageid:write`. */
  rateScope?: string
  ratePerSec?: number
  rateBurst?: number
  /** Skip the global limiter (used for local/dev calls). */
  skipLimiter?: boolean
}

export function buildUrl(base: string, query?: HttpOptions['query']): string {
  if (!query) return base
  const url = new URL(base)
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }
  return url.toString()
}

export async function http<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const {
    method = 'GET',
    json,
    form,
    headers = {},
    timeoutMs = 30_000,
    retries = 3,
    rateScope,
    ratePerSec = 8,
    rateBurst = 12,
    skipLimiter,
  } = opts

  const fullUrl = buildUrl(url, opts.query)
  let attempt = 0
  let lastErr: unknown

  while (attempt <= retries) {
    try {
      if (!skipLimiter) {
        await globalBucket.take(`global:${method}`)
        if (rateScope) await limiterFor(rateScope, ratePerSec, rateBurst).take(rateScope)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort()
        else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }

      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/json',
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : undefined,
        signal: controller.signal,
      }

      const res = await fetch(fullUrl, init)
      clearTimeout(timer)
      const text = await res.text()
      let body: unknown = text
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }

      if (!res.ok) {
        throw new ApiError(`HTTP ${res.status} ${method} ${safeUrl(fullUrl)}`, {
          status: res.status,
          body,
          code: extractErrorCode(body),
          retryable: res.status === 429 || res.status >= 500,
        })
      }
      return body as T
    } catch (err) {
      lastErr = err
      const apiErr = err instanceof ApiError ? (err as ApiError) : null
      const isAbort = (err as Error)?.name === 'AbortError'
      const retryable = apiErr ? apiErr.retryable : isAbort || !(err instanceof TypeError)
      if (!retryable || attempt >= retries) break
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250)
      const retryAfter = apiErr ? retryAfterMs(apiErr.body) : 0
      await sleep(Math.max(backoff, retryAfter))
      attempt++
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function retryAfterMs(body: unknown): number {
  if (!body || typeof body !== 'object') return 0
  const b = body as Record<string, unknown>
  const err = (b.error ?? b.errors) as Record<string, unknown> | undefined
  const raw = (err?.error_user_title as string) || ''
  const m = raw.match(/(\d+)\s*seconds?/)
  if (m) return Number(m[1]) * 1000
  return 0
}

function extractErrorCode(body: unknown): string | number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  const err = b.error as Record<string, unknown> | undefined
  return (err?.code as number) ?? (err?.error_subcode as number) ?? ((b.errors as { code?: string }[])?.[0]?.code) ?? undefined
}

function safeUrl(u: string): string {
  try {
    const url = new URL(u)
    url.searchParams.delete('access_token')
    url.searchParams.delete('client_secret')
    return `${url.pathname}${url.search.slice(0, 80)}`
  } catch {
    return u.slice(0, 120)
  }
}

/** True when an OAuth token needs refreshing (with a safety margin). */
export function tokenExpiringSoon(expiresAt: Date | null | undefined, marginMs = 5 * 60_000): boolean {
  if (!expiresAt) return false
  return expiresAt.getTime() - Date.now() < marginMs
}

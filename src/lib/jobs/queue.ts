
import crypto from 'crypto'
import { prisma } from '@/lib/db'

export type JobType =
  | 'poll_content'
  | 'poll_comments'
  | 'poll_messages'
  | 'generate_draft'
  | 'send_draft'
  | 'refresh_token'
  | 'embed_knowledge'
  | 'sync_account'
  | 'process_webhook'

export interface EnqueueInput {
  type: JobType
  payload?: Record<string, unknown>
  workspaceId?: string | null
  accountId?: string | null
  /** Dedupe key. Two jobs with the same (type, key) cannot coexist while queued. */
  key?: string | null
  runAt?: Date | null
  priority?: number
  maxAttempts?: number
  /** Replace an existing queued job with the same key instead of skipping. */
  replace?: boolean
}

/**
 * Postgres/SQLite-backed job queue. No Redis required.
 * Claiming is transactional via an optimistic row update, so it is safe to run
 * several workers against the same database.
 */
export async function enqueue(input: EnqueueInput): Promise<string | null> {
  const data = {
    type: input.type,
    payload: JSON.stringify(input.payload ?? {}),
    workspaceId: input.workspaceId ?? null,
    accountId: input.accountId ?? null,
    key: input.key ?? null,
    runAt: input.runAt ?? new Date(),
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? 5,
    status: 'queued',
  }

  if (!data.key) {
    const job = await prisma.job.create({ data })
    return job.id
  }

  const existing = await prisma.job.findUnique({ where: { type_key: { type: input.type, key: data.key } } })
  if (existing) {
    if (existing.status === 'queued' || existing.status === 'running') {
      if (input.replace) {
        await prisma.job.update({
          where: { id: existing.id },
          data: { payload: data.payload, runAt: data.runAt, priority: data.priority },
        })
      }
      return null
    }
    // finished/failed → recycle the unique slot
    await prisma.job.update({
      where: { id: existing.id },
      data: {
        status: 'queued',
        payload: data.payload,
        runAt: data.runAt,
        attempts: 0,
        lastError: null,
        result: null,
        lockedAt: null,
        lockedBy: null,
      },
    })
    return existing.id
  }

  try {
    const job = await prisma.job.create({ data })
    return job.id
  } catch {
    // Lost a race on the unique index — that's fine, another worker enqueued it.
    return null
  }
}

export async function claimJob(workerId: string): Promise<{ id: string; type: string; payload: Record<string, unknown>; workspaceId: string | null; accountId: string | null } | null> {
  const candidates = await prisma.job.findMany({
    where: { status: 'queued', runAt: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
    take: 5,
  })

  // Also reclaim jobs stuck in `running` (a worker died mid-flight).
  const staleBefore = new Date(Date.now() - 5 * 60_000)
  const stale = await prisma.job.findMany({
    where: { status: 'running', lockedAt: { lt: staleBefore } },
    take: 3,
  })

  for (const job of [...candidates, ...stale]) {
    const res = await prisma.job.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: 'running', lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
    })
    if (res.count === 1) {
      return {
        id: job.id,
        type: job.type,
        payload: safeParse(job.payload),
        workspaceId: job.workspaceId,
        accountId: job.accountId,
      }
    }
  }
  return null
}

export async function completeJob(id: string, result?: unknown) {
  await prisma.job.update({
    where: { id },
    data: { status: 'done', result: result ? JSON.stringify(result).slice(0, 4000) : null, lockedAt: null, lockedBy: null },
  })
}

export async function failJob(id: string, error: string, opts: { permanent?: boolean; retryDelayMs?: number } = {}) {
  const job = await prisma.job.findUnique({ where: { id } })
  if (!job) return
  const attempts = job.attempts
  const willRetry = !opts.permanent && attempts < job.maxAttempts
  const delay = opts.retryDelayMs ?? Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempts, 7)) + Math.floor(Math.random() * 1000)

  await prisma.job.update({
    where: { id },
    data: {
      status: willRetry ? 'queued' : 'failed',
      lastError: error.slice(0, 2000),
      runAt: willRetry ? new Date(Date.now() + delay) : job.runAt,
      lockedAt: null,
      lockedBy: null,
    },
  })
}

export async function cancelJob(id: string) {
  await prisma.job.updateMany({ where: { id, status: { in: ['queued', 'failed'] } }, data: { status: 'cancelled' } })
}

export async function queueStats(workspaceId?: string) {
  const where = workspaceId ? { workspaceId } : {}
  const [queued, running, failed, done] = await Promise.all([
    prisma.job.count({ where: { ...where, status: 'queued' } }),
    prisma.job.count({ where: { ...where, status: 'running' } }),
    prisma.job.count({ where: { ...where, status: 'failed' } }),
    prisma.job.count({ where: { ...where, status: 'done' } }),
  ])
  return { queued, running, failed, done }
}

export function workerId(): string {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

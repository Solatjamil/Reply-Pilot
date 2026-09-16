
import { claimJob, completeJob, failJob, workerId } from '../jobs/queue'
import { HANDLERS, dispatchScheduledDrafts, schedulePolling } from './handlers'
import { logEvent } from '../log'
import { env } from '../env'

const globalForWorker = globalThis as unknown as { __replypilotWorker?: { stop: () => void; startedAt: number } }

export interface WorkerOptions {
  concurrency?: number
  pollEveryMs?: number
  scheduleEveryMs?: number
  quiet?: boolean
}

/**
 * Long-running worker loop.
 *
 *   • development / single-VM production: started in-process by
 *     `src/instrumentation.ts` (ENABLE_INPROC_WORKER=1) or via `npm run worker`
 *   • horizontal scale: run `npm run worker` as its own process/container and
 *     set ENABLE_INPROC_WORKER=0 on the web tier
 */
export function startWorker(opts: WorkerOptions = {}) {
  if (globalForWorker.__replypilotWorker) return globalForWorker.__replypilotWorker

  const concurrency = opts.concurrency ?? env.worker.concurrency
  const pollEveryMs = opts.pollEveryMs ?? env.worker.pollIntervalSeconds * 1000
  const scheduleEveryMs = opts.scheduleEveryMs ?? 10_000
  const id = workerId()
  const log = opts.quiet ? () => undefined : (...args: unknown[]) => console.log('[worker]', ...args)

  let stopped = false
  let inflight = 0
  const timers: NodeJS.Timeout[] = []

  const tick = async () => {
    if (stopped) return
    while (!stopped && inflight < concurrency) {
      let job: Awaited<ReturnType<typeof claimJob>> = null
      try {
        job = await claimJob(id)
      } catch (err) {
        log('claim failed:', (err as Error).message)
        break
      }
      if (!job) break

      inflight++
      void runJob(job)
        .catch((err) => log('job crashed:', job?.type, (err as Error).message))
        .finally(() => {
          inflight--
        })
    }
  }

  const runJob = async (job: NonNullable<Awaited<ReturnType<typeof claimJob>>>) => {
    const handler = HANDLERS[job.type]
    if (!handler) {
      await failJob(job.id, `No handler registered for job type "${job.type}"`, { permanent: true })
      return
    }
    const started = Date.now()
    try {
      const result = await handler({
        jobId: job.id,
        type: job.type,
        payload: job.payload,
        workspaceId: job.workspaceId,
        accountId: job.accountId,
      })
      await completeJob(job.id, result)
      log(`${job.type} done in ${Date.now() - started}ms`)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      const permanent =
        /not found|missing|no adapter|does not support|cannot send|not authorized|capability/i.test(message) &&
        !/timeout|network|socket|ECONN/i.test(message)
      await failJob(job.id, message, { permanent })
      log(`${job.type} failed (attempt, permanent=${permanent}): ${message.slice(0, 200)}`)
      await logEvent({
        workspaceId: job.workspaceId,
        accountId: job.accountId,
        type: 'job.failed',
        level: 'warn',
        message: `${job.type}: ${message.slice(0, 500)}`,
      })
    }
  }

  const safeInterval = (fn: () => Promise<unknown>, ms: number, label: string) => {
    const run = async () => {
      if (stopped) return
      try {
        await fn()
      } catch (err) {
        console.error(`[worker] ${label} failed:`, (err as Error).message)
      }
    }
    void run()
    timers.push(setInterval(run, ms))
  }

  safeInterval(tick, 1500, 'job tick')
  safeInterval(() => dispatchScheduledDrafts(), scheduleEveryMs, 'dispatch scheduled drafts')
  safeInterval(() => schedulePolling(), pollEveryMs, 'schedule polling')

  log(`started (id=${id}, concurrency=${concurrency}, poll=${Math.round(pollEveryMs / 1000)}s)`)

  const stop = () => {
    stopped = true
    timers.forEach(clearInterval)
    delete globalForWorker.__replypilotWorker
    log('stopped')
  }

  globalForWorker.__replypilotWorker = { stop, startedAt: Date.now() }
  return globalForWorker.__replypilotWorker
}

/** Drains the queue once and exits — useful for cron / serverless deployments. */
export async function drainQueue(opts: { maxSeconds?: number; stopWhenIdle?: boolean } = {}) {
  const maxMs = (opts.maxSeconds ?? 30) * 1000
  const deadline = Date.now() + maxMs
  let processed = 0
  const id = workerId()

  await schedulePolling()
  await dispatchScheduledDrafts()

  while (Date.now() < deadline) {
    const job = await claimJob(id)
    if (!job) {
      // A long-lived worker idles and keeps polling. A serverless invocation
      // must return as soon as the queue is empty instead of spinning until the
      // deadline and burning invocation time.
      if (opts.stopWhenIdle) break
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const handler = HANDLERS[job.type]
    if (!handler) {
      await failJob(job.id, `No handler for ${job.type}`, { permanent: true })
      continue
    }
    try {
      const result = await handler({
        jobId: job.id,
        type: job.type,
        payload: job.payload,
        workspaceId: job.workspaceId,
        accountId: job.accountId,
      })
      await completeJob(job.id, result)
      processed++
    } catch (err) {
      await failJob(job.id, (err as Error).message)
    }
  }
  return { processed }
}

import { after } from 'next/server'

/**
 * True when running on a serverless platform (Vercel). There the process is
 * frozen between requests, so a long-lived polling worker cannot exist — the
 * queue has to be drained by the requests themselves and by cron.
 */
export const isServerless = Boolean(process.env.VERCEL)

/**
 * Webhook receivers must ACK fast (Meta unsubscribes an endpoint that misses
 * its 5-second SLA), so the payload is enqueued and the response returned
 * immediately.
 *
 * On a normal server a worker picks the job up. On serverless there is no
 * worker, so this drains the queue *after* the response has been sent —
 * Next.js `after()` keeps the invocation alive for that work without delaying
 * the ACK. Self-hosted deployments skip it entirely and let the worker own the
 * queue, so the two never compete.
 */
export function drainAfterResponse(maxSeconds = 10) {
  if (!isServerless) return

  after(async () => {
    try {
      const { drainQueue } = await import('@/lib/worker')
      await drainQueue({ maxSeconds, stopWhenIdle: true })
    } catch (err) {
      // Never let post-response work surface as a request failure. The job
      // stays queued and the cron in vercel.json will pick it up.
      console.error('[serverless] inline queue drain failed:', (err as Error).message)
    }
  })
}

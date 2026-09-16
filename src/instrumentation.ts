/**
 * Next.js instrumentation hook — runs once when the Node.js server boots.
 * Used to start the in-process background worker during development and on
 * single-server deployments. Set ENABLE_INPROC_WORKER=0 and run `npm run worker`
 * separately when scaling horizontally or deploying to serverless.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Serverless functions are frozen between requests, so a polling loop here
  // would never reliably fire and would burn invocation time trying. On Vercel
  // the queue is drained inline after each webhook (see src/lib/serverless.ts)
  // and by the cron jobs in vercel.json.
  if (process.env.VERCEL) return

  // Avoid double-starting under Turbopack/Webpack HMR reloads.
  const flag = globalThis as unknown as { __replypilotInstrumented?: boolean }
  if (flag.__replypilotInstrumented) return
  flag.__replypilotInstrumented = true

  if (process.env.ENABLE_INPROC_WORKER !== '1') return

  const { startWorker } = await import('@/lib/worker')
  startWorker({ quiet: false })
}

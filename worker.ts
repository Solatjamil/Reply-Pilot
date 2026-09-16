/**
 * Standalone background worker.
 *   npm run worker
 *
 * Run this as its own process/container in production and set
 * ENABLE_INPROC_WORKER=0 on the web tier so polling isn't duplicated.
 */
import 'dotenv/config'
import { startWorker } from '@/lib/worker'

startWorker({ quiet: false })

console.log('[replypilot] worker started — press Ctrl+C to stop')

let stopping = false
const shutdown = (signal: string) => {
  if (stopping) return
  stopping = true
  console.log(`[replypilot] ${signal} received, shutting down…`)
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => console.error('[replypilot] unhandled rejection:', err))

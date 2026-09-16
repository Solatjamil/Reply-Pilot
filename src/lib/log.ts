
import { prisma } from '@/lib/db'

export interface LogInput {
  workspaceId?: string | null
  accountId?: string | null
  type: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: unknown
}

/** Append-only audit/debug log. Never throws — logging must not break a job. */
export async function logEvent(input: LogInput): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        accountId: input.accountId ?? null,
        type: input.type,
        level: input.level ?? 'info',
        message: String(input.message).slice(0, 2000),
        data: safeStringify(input.data),
      },
    })
  } catch (err) {
    console.warn('[log] failed to persist event', input.type, (err as Error).message)
  }
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '{}'
  try {
    const json = JSON.stringify(value)
    return json.length > 8000 ? `${json.slice(0, 8000)}…` : json
  } catch {
    return '{}'
  }
}

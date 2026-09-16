'use client'

import { useState } from 'react'
import { Icon } from './icons'

export function CopyRow({ label, value, hint }: { label?: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard API is blocked in some embedded previews — fall back.
      const ta = document.createElement('textarea')
      ta.value = value
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="min-w-0 flex-1">
        {label ? <div className="text-[11px] font-medium text-mist-300">{label}</div> : null}
        <code className="block truncate font-mono text-[11px] text-accent-400">{value}</code>
        {hint ? <div className="mt-0.5 text-[10px] text-mist-400">{hint}</div> : null}
      </div>
      <button onClick={copy} className="btn-ghost btn-sm shrink-0">
        {copied ? <Icon name="check" size={13} /> : <Icon name="edit" size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export function XWebhookButton({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/x/register-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; webhookId?: string }
      setResult({ ok: Boolean(json.ok), message: json.ok ? `Registered (webhook ${json.webhookId})` : (json.error ?? 'Failed') })
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={busy} className="btn-ghost btn-sm">
        <Icon name="bolt" size={13} /> {busy ? 'Registering…' : 'Register X webhook + subscription'}
      </button>
      {result ? <span className={`text-[11px] ${result.ok ? 'text-mint-400' : 'text-rose-400'}`}>{result.message}</span> : null}
    </div>
  )
}

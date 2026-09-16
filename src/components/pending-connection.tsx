'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PlatformIcon, Icon } from './icons'
import { Badge } from './ui'

export interface PendingProfile {
  platform: string
  platformUid: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
  profileUrl?: string | null
  warning?: string
  capabilities?: {
    readComments?: boolean
    replyToComment?: boolean
    readDms?: boolean
    sendDm?: boolean
    privateReplyFromComment?: boolean
    requiresAccessRequest?: string[]
    notes?: string[]
  }
}

export function PendingConnection({
  jobId,
  provider,
  profiles,
  expiresAt,
}: {
  jobId: string
  provider: string
  profiles: PendingProfile[]
  expiresAt: string
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(profiles.map((p) => `${p.platform}:${p.platformUid}`)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<string, PendingProfile[]>()
    for (const p of profiles) {
      const list = map.get(p.platform) ?? []
      list.push(p)
      map.set(p.platform, list)
    }
    return [...map.entries()]
  }, [profiles])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const finish = async () => {
    if (selected.size === 0) {
      setError('Pick at least one profile to attach.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/connect/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: jobId, selected: [...selected] }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? `Could not attach profiles (${res.status})`)
        return
      }
      router.push('/accounts?ok=connected')
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10 fade-in">
      <header className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-mint-500/12 text-mint-400">
          <Icon name="check" size={24} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{provider} authorized</h1>
        <p className="muted mt-2">
          Now attach the profiles ReplyPilot should answer for. You can add or remove them any time from{' '}
          <span className="text-mist-200">Connected profiles</span>.
        </p>
        <p className="mt-2 text-[11px] text-mist-400">This session expires {new Date(expiresAt).toLocaleTimeString()}</p>
      </header>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-400/8 p-3 text-sm text-rose-400">
          <Icon name="warning" size={16} /> {error}
        </div>
      ) : null}

      <div className="space-y-5">
        {grouped.map(([platform, list]) => (
          <section key={platform} className="space-y-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mist-400">
              <PlatformIcon platform={platform} size={13} /> {labelFor(platform)} · {list.length}
            </h2>
            <div className="card divide-y divide-ink-800">
              {list.map((p) => {
                const key = `${p.platform}:${p.platformUid}`
                const on = selected.has(key)
                const caps = p.capabilities ?? {}
                return (
                  <label key={key} className={`flex cursor-pointer items-start gap-3 p-4 transition-colors ${on ? 'bg-accent-500/5' : 'hover:bg-ink-850/50'}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(key)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[#5b6cff]"
                    />
                    {p.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.avatarUrl} alt="" className="mt-0.5 h-9 w-9 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-800 text-mist-300">
                        <PlatformIcon platform={platform} size={16} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-white">{p.name}</span>
                        {p.handle ? <span className="text-xs text-mist-400">{p.handle}</span> : null}
                        <CapabilityPills caps={caps} />
                      </div>
                      {p.warning ? (
                        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] leading-relaxed text-amber-400/90">{p.warning}</p>
                      ) : null}
                      {caps.requiresAccessRequest?.length ? (
                        <ul className="mt-2 space-y-1">
                          {caps.requiresAccessRequest.map((r) => (
                            <li key={r} className="text-[11px] leading-relaxed text-amber-400/80">· {r}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </label>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-2">
          <button onClick={() => setSelected(new Set(profiles.map((p) => `${p.platform}:${p.platformUid}`)))} className="btn-ghost btn-sm">
            Select all
          </button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost btn-sm">
            Clear
          </button>
          <span className="ml-1 text-xs text-mist-400">{selected.size} selected</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => router.push('/accounts')} className="btn-ghost btn-sm">
            Cancel
          </button>
          <button onClick={finish} disabled={busy || selected.size === 0} className="btn-primary">
            {busy ? 'Attaching…' : `Attach ${selected.size} profile${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function CapabilityPills({ caps }: { caps: PendingProfile['capabilities'] }) {
  if (!caps) return null
  return (
    <span className="flex flex-wrap gap-1">
      <Pill on={Boolean(caps.readComments && caps.replyToComment)} label="comments" />
      <Pill on={Boolean(caps.readDms && caps.sendDm)} label="DMs" />
      <Pill on={Boolean(caps.privateReplyFromComment)} label="comment→DM" />
    </span>
  )
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <Badge tone="good">{label}</Badge>
  ) : (
    <span className="rounded-full border border-ink-600 bg-ink-800 px-2 py-px text-[10px] text-mist-400/60 line-through">{label}</span>
  )
}

function labelFor(platform: string) {
  const map: Record<string, string> = {
    facebook_page: 'Facebook Pages',
    instagram: 'Instagram accounts',
    messenger: 'Messenger inboxes',
    youtube: 'YouTube channels',
    linkedin_org: 'LinkedIn company pages',
    linkedin_person: 'LinkedIn profiles',
    x: 'X accounts',
    tiktok: 'TikTok accounts',
  }
  return map[platform] ?? platform
}

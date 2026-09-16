'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Icon, PlatformIcon } from './icons'
import { Field, Toggle } from './ui'

export interface AutomationData {
  accountId: string
  replyToComments: boolean
  replyToDms: boolean
  replyToMentions: boolean
  autoSendEnabled: boolean
  autoSendThreshold: number
  reviewThreshold: number
  minDelaySeconds: number
  maxDelaySeconds: number
  maxAutoPerHour: number
  maxAutoPerDay: number
  maxRepliesPerUser: number
  skipOwnComments: boolean
  skipRepliesToUs: boolean
  skipLowEffort: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
  language: string
  brandVoiceId: string | null
}

export interface AutomationAccount {
  id: string
  name: string
  platform: string
  handle: string | null
  capabilities: { readComments?: boolean; replyToComment?: boolean; readDms?: boolean; sendDm?: boolean }
}

export function AutomationsClient({
  accounts,
  automations,
  voices,
}: {
  accounts: AutomationAccount[]
  automations: (AutomationData & { accountId: string })[]
  voices: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [activeId, setActiveId] = useState(accounts[0]?.id ?? '')
  const [, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const initial = automations.find((a) => a.accountId === activeId) ?? null
  // Edits are held locally and keyed by the account they belong to, so
  // switching accounts swaps in that account's saved config without an effect
  // (which would cascade a render on every switch).
  const [edits, setEdits] = useState<Record<string, AutomationData>>({})
  const form = edits[activeId] ?? initial

  const selectAccount = (id: string) => {
    setActiveId(id)
    setSaved(false)
    setError(null)
  }

  const account = accounts.find((a) => a.id === activeId)

  const set = <K extends keyof AutomationData>(key: K, value: AutomationData[K]) => {
    if (!form) return
    setEdits((prev) => ({ ...prev, [activeId]: { ...form, [key]: value } }))
    setSaved(false)
  }

  const save = async () => {
    if (!form) return
    if (form.reviewThreshold > form.autoSendThreshold) {
      setError('The review threshold must be lower than the auto-send threshold.')
      return
    }
    if (form.maxDelaySeconds < form.minDelaySeconds) {
      setError('Max delay must be greater than min delay.')
      return
    }
    setError(null)
    const res = await fetch('/api/automations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, accountId: activeId }),
    })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      setError(json.error ?? `Save failed (${res.status})`)
      return
    }
    setSaved(true)
    startTransition(() => router.refresh())
    setTimeout(() => setSaved(false), 3000)
  }

  if (accounts.length === 0) {
    return (
      <div className="card-pad text-center text-sm text-mist-400">
        Connect a social profile first — automation rules are configured per profile.
      </div>
    )
  }

  if (!form) {
    return (
      <div className="space-y-4">
        <AccountTabs accounts={accounts} activeId={activeId} onSelect={selectAccount} />
        <div className="card-pad text-sm text-mist-400">Loading rules…</div>
      </div>
    )
  }

  const caps = account?.capabilities ?? {}

  return (
    <div className="space-y-5">
      <AccountTabs accounts={accounts} activeId={activeId} onSelect={selectAccount} />

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-400/8 p-3 text-xs text-rose-400">
          <Icon name="warning" size={15} /> {error}
        </div>
      ) : null}

      {/* ── Confidence routing ── */}
      <section className="card-pad space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-white">How confident does the AI need to be?</h2>
          <p className="muted mt-1 text-xs">
            Every reply is scored 0–100%. Above the green line it posts itself. Between the lines it waits here for one click. Below the
            red line a human is required.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">Auto-send above</label>
              <span className="font-mono text-sm font-semibold text-mint-400">{Math.round(form.autoSendThreshold * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={form.autoSendThreshold}
              onChange={(e) => set('autoSendThreshold', Number(e.target.value))}
              className="w-full accent-[#10b981]"
            />
            <div className="mt-1.5 flex justify-between text-[10px] text-mist-400">
              <span>50% — risky</span>
              <span>100% — only exact matches</span>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">Escalate to human below</label>
              <span className="font-mono text-sm font-semibold text-rose-400">{Math.round(form.reviewThreshold * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.01}
              value={form.reviewThreshold}
              onChange={(e) => set('reviewThreshold', Number(e.target.value))}
              className="w-full accent-[#fb7185]"
            />
            <div className="mt-1.5 flex justify-between text-[10px] text-mist-400">
              <span>0% — queue everything</span>
              <span>95% — almost nothing escalates</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-ink-700 bg-ink-850 p-4">
          <div className="mb-2 flex h-8 overflow-hidden rounded-lg text-[10px] font-semibold">
            <div className="flex items-center justify-center bg-rose-400/25 text-rose-400" style={{ width: `${form.reviewThreshold * 100}%` }}>
              human
            </div>
            <div
              className="flex items-center justify-center bg-amber-400/25 text-amber-400"
              style={{ width: `${Math.max(0, (form.autoSendThreshold - form.reviewThreshold) * 100)}%` }}
            >
              approve
            </div>
            <div
              className="flex items-center justify-center bg-mint-500/25 text-mint-400"
              style={{ width: `${Math.max(0, (1 - form.autoSendThreshold) * 100)}%` }}
            >
              auto-send
            </div>
          </div>
          <Toggle
            checked={form.autoSendEnabled}
            onChange={(v) => set('autoSendEnabled', v)}
            label="Auto-send confident replies"
            hint="Turn this off to review every single reply before it posts (recommended for the first week)."
          />
        </div>
      </section>

      {/* ── What to reply to ── */}
      <section className="card-pad">
        <h2 className="text-sm font-semibold text-white">What ReplyPilot answers</h2>
        <div className="mt-2 divide-y divide-ink-800">
          <Toggle
            checked={form.replyToComments}
            onChange={(v) => set('replyToComments', v)}
            label="Public comments"
            hint={caps.replyToComment === false ? 'Not available with this profile’s current API access.' : 'Replies post publicly under the comment.'}
          />
          <Toggle
            checked={form.replyToDms}
            onChange={(v) => set('replyToDms', v)}
            label="Direct messages"
            hint={caps.sendDm === false ? 'Not available with this profile’s current API access.' : 'Replies land in the existing conversation.'}
          />
          <Toggle checked={form.replyToMentions} onChange={(v) => set('replyToMentions', v)} label="@mentions of this profile" />
          <Toggle checked={form.skipOwnComments} onChange={(v) => set('skipOwnComments', v)} label="Skip comments from your own accounts" hint="Prevents bot-vs-bot loops across your profiles." />
          <Toggle checked={form.skipRepliesToUs} onChange={(v) => set('skipRepliesToUs', v)} label="Skip replies to replies you already posted" />
          <Toggle checked={form.skipLowEffort} onChange={(v) => set('skipLowEffort', v)} label="Skip low-effort comments" hint="Emoji-only, “nice”, “🔥”, single characters — no reply needed." />
        </div>
      </section>

      {/* ── Humanisation & volume guards ── */}
      <section className="card-pad space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Anti-spam &amp; humanisation guards</h2>
          <p className="muted mt-1 text-xs">Platform algorithms and real users both notice instant, identical replies. These keep you safe.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Minimum delay (seconds)" hint="Replies never post instantly.">
            <input type="number" min={0} max={3600} className="input" value={form.minDelaySeconds} onChange={(e) => set('minDelaySeconds', Number(e.target.value))} />
          </Field>
          <Field label="Maximum delay (seconds)">
            <input type="number" min={0} max={7200} className="input" value={form.maxDelaySeconds} onChange={(e) => set('maxDelaySeconds', Number(e.target.value))} />
          </Field>
          <Field label="Max replies per person, per post">
            <input type="number" min={0} max={100} className="input" value={form.maxRepliesPerUser} onChange={(e) => set('maxRepliesPerUser', Number(e.target.value))} />
          </Field>
          <Field label="Hourly auto-send cap">
            <input type="number" min={0} max={5000} className="input" value={form.maxAutoPerHour} onChange={(e) => set('maxAutoPerHour', Number(e.target.value))} />
          </Field>
          <Field label="Daily auto-send cap">
            <input type="number" min={0} max={50000} className="input" value={form.maxAutoPerDay} onChange={(e) => set('maxAutoPerDay', Number(e.target.value))} />
          </Field>
          <Field label="Reply language" hint="“auto” mirrors the commenter’s language.">
            <select className="input" value={form.language} onChange={(e) => set('language', e.target.value)}>
              <option value="auto">Auto-detect</option>
              {['en', 'es', 'pt', 'fr', 'de', 'ar', 'ur', 'hi', 'zh', 'ja', 'ko', 'tr', 'id', 'ru'].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="divider" />

        <Toggle checked={form.quietHoursEnabled} onChange={(v) => set('quietHoursEnabled', v)} label="Quiet hours" hint="Auto-send pauses overnight; drafts still queue for morning review." />
        {form.quietHoursEnabled ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From">
              <input type="time" className="input" value={form.quietHoursStart} onChange={(e) => set('quietHoursStart', e.target.value)} />
            </Field>
            <Field label="To">
              <input type="time" className="input" value={form.quietHoursEnd} onChange={(e) => set('quietHoursEnd', e.target.value)} />
            </Field>
            <Field label="Timezone">
              <select className="input" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {['UTC', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'].map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
      </section>

      {/* ── Voice ── */}
      <section className="card-pad space-y-3">
        <h2 className="text-sm font-semibold text-white">Voice for this profile</h2>
        <Field label="Brand voice">
          <select className="input" value={form.brandVoiceId ?? ''} onChange={(e) => set('brandVoiceId', e.target.value || null)}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-mist-400">
          Edit personas, banned words and few-shot examples in <a href="/brand" className="text-accent-400 hover:underline">Brand voice</a>.
        </p>
      </section>

      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl border border-ink-700 bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
        {saved ? (
          <span className="flex items-center gap-1.5 text-xs text-mint-400">
            <Icon name="check" size={14} /> Saved
          </span>
        ) : null}
        <button onClick={save} className="btn-primary">
          Save rules
        </button>
      </div>
    </div>
  )
}

function AccountTabs({
  accounts,
  activeId,
  onSelect,
}: {
  accounts: AutomationAccount[]
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {accounts.map((a) => (
        <button
          key={a.id}
          onClick={() => onSelect(a.id)}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
            activeId === a.id ? 'border-accent-500/50 bg-accent-500/12 text-white' : 'border-ink-700 bg-ink-900 text-mist-400 hover:text-mist-200'
          }`}
        >
          <PlatformIcon platform={a.platform} size={14} />
          {a.name}
        </button>
      ))}
    </div>
  )
}


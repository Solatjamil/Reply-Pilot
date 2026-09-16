'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from './icons'
import { Badge, Field } from './ui'

interface TestReplyResult {
  latencyMs: number
  draft: {
    text: string
    alternates?: string[]
    confidence: number
    action: string
    intent: string
    sentiment?: string
    language?: string
    reasoning?: string
    flaggedFor?: string[]
    llmProvider?: string
    llmModel?: string
    knowledgeUsed?: { id: string; title: string }[]
  }
}

export interface VoiceData {
  id: string
  name: string
  persona: string
  tone: string
  language: string
  emojiPolicy: string
  signOff: string | null
  bannedWords: string[]
  mustInclude: string[]
  maxChars: number
  examples: { comment: string; reply: string }[]
  isDefault: boolean
}

const PRESETS: { id: string; label: string; persona: string; tone: string; emojiPolicy: string }[] = [
  {
    id: 'friendly',
    label: 'Friendly & warm',
    persona:
      'You are a warm, upbeat community manager. You greet people by name when you can, thank them genuinely, and keep replies short and human. You use contractions and everyday words.',
    tone: 'friendly, warm, upbeat',
    emojiPolicy: 'sparingly',
  },
  {
    id: 'professional',
    label: 'Professional & precise',
    persona:
      'You are a precise, professional customer success representative. You answer directly, avoid fluff, use complete sentences, and always state the next concrete step.',
    tone: 'professional, clear, concise',
    emojiPolicy: 'none',
  },
  {
    id: 'playful',
    label: 'Playful & bold',
    persona:
      'You are a witty social media manager with a playful streak. You can be cheeky and use light humour, but you never punch down, never mock a customer, and you always still answer the question.',
    tone: 'playful, witty, bold',
    emojiPolicy: 'freely',
  },
  {
    id: 'support',
    label: 'Support-first (empathetic)',
    persona:
      'You are a patient support agent. You acknowledge the customer’s feeling first in one short sentence, then solve. You never blame the customer and never promise timelines you cannot confirm.',
    tone: 'empathetic, calm, solution-oriented',
    emojiPolicy: 'none',
  },
]

export function BrandVoiceClient({ voices, accounts }: { voices: VoiceData[]; accounts: { id: string; name: string }[] }) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState(voices[0]?.id ?? '')
  const savedVoice = voices.find((v) => v.id === selectedId) ?? voices[0] ?? null
  // Local edits are keyed by voice id, so switching voices swaps in that
  // voice's saved values without an effect (which would cascade a render).
  const [edits, setEdits] = useState<Record<string, VoiceData>>({})
  const form = edits[selectedId] ?? savedVoice
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Playground state
  const [testComment, setTestComment] = useState('How much does shipping cost and do you deliver to Lahore?')
  const [testPost, setTestPost] = useState('')
  const [testAccountId, setTestAccountId] = useState(accounts[0]?.id ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestReplyResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)


  const set = <K extends keyof VoiceData>(key: K, value: VoiceData[K]) => {
    if (!form) return
    setEdits((prev) => ({ ...prev, [selectedId]: { ...form, [key]: value } }))
    setSaved(false)
  }

  const save = async () => {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/brand-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? `Save failed (${res.status})`)
        return
      }
      setSaved(true)
      router.refresh()
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const createVoice = async () => {
    setSaving(true)
    const res = await fetch('/api/brand-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New voice', persona: PRESETS[0].persona, tone: PRESETS[0].tone }),
    })
    const json = (await res.json().catch(() => ({}))) as { voice?: { id: string } }
    setSaving(false)
    if (json.voice?.id) {
      setSelectedId(json.voice.id)
      router.refresh()
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const res = await fetch('/api/test-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: testAccountId || undefined, comment: testComment, post: testPost || undefined }),
      })
      const json = await res.json()
      if (!res.ok) {
        setTestError(json.error ?? `Test failed (${res.status})`)
        return
      }
      setTestResult(json)
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  if (!form) {
    return (
      <div className="card-pad space-y-3 text-center">
        <p className="text-sm text-mist-400">No brand voice yet.</p>
        <button onClick={createVoice} className="btn-primary">
          Create the first voice
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {voices.map((v) => (
          <button
            key={v.id}
            onClick={() => setSelectedId(v.id)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              selectedId === v.id ? 'border-accent-500/50 bg-accent-500/12 text-white' : 'border-ink-700 bg-ink-900 text-mist-400 hover:text-mist-200'
            }`}
          >
            {v.name}
            {v.isDefault ? <Badge tone="accent">default</Badge> : null}
          </button>
        ))}
        <button onClick={createVoice} disabled={saving} className="btn-ghost btn-sm">
          <Icon name="plus" size={14} /> New voice
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <section className="card-pad space-y-4">
            <Field label="Voice name">
              <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>

            <div>
              <label className="label">Start from a preset</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      set('persona', p.persona)
                      set('tone', p.tone)
                      set('emojiPolicy', p.emojiPolicy)
                    }}
                    className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-left text-xs text-mist-300 transition-colors hover:border-accent-500/40 hover:text-white"
                  >
                    <span className="block font-medium text-mist-100">{p.label}</span>
                    <span className="mt-0.5 block text-[11px] text-mist-400">{p.tone}</span>
                  </button>
                ))}
              </div>
            </div>

            <Field label="Persona / system instructions" hint="This is injected verbatim into every reply. Be specific about who you are, what you sell, and what you never say.">
              <textarea className="input min-h-[140px] leading-relaxed" value={form.persona} onChange={(e) => set('persona', e.target.value)} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tone keywords">
                <input className="input" value={form.tone} onChange={(e) => set('tone', e.target.value)} />
              </Field>
              <Field label="Emoji policy">
                <select className="input" value={form.emojiPolicy} onChange={(e) => set('emojiPolicy', e.target.value)}>
                  <option value="none">None</option>
                  <option value="sparingly">Sparingly</option>
                  <option value="freely">Freely</option>
                </select>
              </Field>
              <Field label="Sign-off (optional)">
                <input className="input" value={form.signOff ?? ''} onChange={(e) => set('signOff', e.target.value || null)} placeholder="— The Acme team" />
              </Field>
              <Field label="Max characters">
                <input type="number" min={20} max={8000} className="input" value={form.maxChars} onChange={(e) => set('maxChars', Number(e.target.value))} />
              </Field>
            </div>

            <Field label="Banned words" hint="Comma-separated. A draft containing any of these can never auto-send.">
              <input className="input" value={form.bannedWords.join(', ')} onChange={(e) => set('bannedWords', splitList(e.target.value))} placeholder="guarantee, cheapest, lawsuit" />
            </Field>
          </section>

          <section className="card-pad space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Few-shot examples</h2>
              <button
                onClick={() => set('examples', [...form.examples, { comment: '', reply: '' }])}
                className="btn-ghost btn-sm"
              >
                <Icon name="plus" size={13} /> Add example
              </button>
            </div>
            <p className="muted text-xs">Real question → real answer pairs. Two or three of these improve tone consistency more than any instruction.</p>
            {form.examples.length === 0 ? <div className="rounded-lg border border-dashed border-ink-700 p-4 text-center text-xs text-mist-400">No examples yet.</div> : null}
            {form.examples.map((ex, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-3">
                <textarea
                  className="input text-xs"
                  rows={2}
                  placeholder="Customer comment…"
                  value={ex.comment}
                  onChange={(e) => {
                    const next = [...form.examples]
                    next[i] = { ...ex, comment: e.target.value }
                    set('examples', next)
                  }}
                />
                <textarea
                  className="input text-xs"
                  rows={2}
                  placeholder="The reply you would post…"
                  value={ex.reply}
                  onChange={(e) => {
                    const next = [...form.examples]
                    next[i] = { ...ex, reply: e.target.value }
                    set('examples', next)
                  }}
                />
                <button
                  onClick={() => set('examples', form.examples.filter((_, idx) => idx !== i))}
                  className="text-[11px] text-mist-400 hover:text-rose-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </section>

          {error ? <p className="rounded-lg border border-rose-400/30 bg-rose-400/8 p-3 text-xs text-rose-400">{error}</p> : null}

          <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl border border-ink-700 bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
            {saved ? (
              <span className="flex items-center gap-1.5 text-xs text-mint-400">
                <Icon name="check" size={14} /> Saved
              </span>
            ) : null}
            {!form.isDefault && voices.length > 1 ? (
              <button
                onClick={async () => {
                  await fetch(`/api/brand-voice?id=${form.id}`, { method: 'DELETE' })
                  setSelectedId(voices.find((v) => v.isDefault)?.id ?? voices[0]?.id ?? '')
                  router.refresh()
                }}
                className="btn-danger btn-sm"
              >
                Delete voice
              </button>
            ) : null}
            <button onClick={() => set('isDefault', true)} className="btn-ghost btn-sm">
              Make default
            </button>
            <button onClick={save} disabled={saving} className="btn-primary">
              {saving ? 'Saving…' : 'Save voice'}
            </button>
          </div>
        </div>

        {/* ── Playground ── */}
        <div className="lg:col-span-2">
          <section className="card-pad space-y-4 lg:sticky lg:top-6">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Icon name="sparkle" size={15} className="text-accent-400" /> Test a reply
              </h2>
              <p className="muted mt-1 text-xs">Runs the real engine (safety rules + knowledge base + this voice) without posting anything.</p>
            </div>

            <Field label="Sample comment or DM">
              <textarea className="input" rows={3} value={testComment} onChange={(e) => setTestComment(e.target.value)} />
            </Field>
            <Field label="Post it sits on (optional)">
              <textarea className="input" rows={2} value={testPost} onChange={(e) => setTestPost(e.target.value)} placeholder="Caption of the post being commented on" />
            </Field>
            {accounts.length ? (
              <Field label="Profile (uses its rules)">
                <select className="input" value={testAccountId} onChange={(e) => setTestAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <button onClick={runTest} disabled={testing || !testComment.trim()} className="btn-primary w-full">
              {testing ? 'Thinking…' : 'Generate test reply'}
            </button>

            {testError ? <p className="rounded-lg border border-rose-400/30 bg-rose-400/8 p-3 text-xs leading-relaxed text-rose-400">{testError}</p> : null}

            {testResult?.draft ? (
              <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-850 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={testResult.draft.action === 'auto_send' ? 'good' : testResult.draft.action === 'escalate' ? 'bad' : 'warn'}>
                    {testResult.draft.action.replace('_', ' ')}
                  </Badge>
                  <span className="font-mono text-xs text-mist-300">{Math.round(testResult.draft.confidence * 100)}% confidence</span>
                  <Badge tone="accent">{testResult.draft.intent}</Badge>
                  <span className="font-mono text-[10px] text-mist-400">
                    {testResult.draft.llmProvider}/{testResult.draft.llmModel} · {testResult.latencyMs}ms
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-mist-100">{testResult.draft.text || '(no reply — skipped)'}</p>
                {testResult.draft.alternates?.length ? (
                  <div className="space-y-1.5 border-t border-ink-700 pt-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-mist-400">Alternates</div>
                    {testResult.draft.alternates.map((a: string, i: number) => (
                      <p key={i} className="text-xs text-mist-300">
                        · {a}
                      </p>
                    ))}
                  </div>
                ) : null}
                {testResult.draft.flaggedFor?.length ? (
                  <div className="flex flex-wrap gap-1.5 border-t border-ink-700 pt-2.5">
                    {testResult.draft.flaggedFor.map((f: string) => (
                      <Badge key={f} tone="warn">
                        {f.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {testResult.draft.knowledgeUsed?.length ? (
                  <p className="border-t border-ink-700 pt-2.5 text-[11px] text-mist-400">
                    Grounded in: {testResult.draft.knowledgeUsed?.map((k) => k.title).join(', ')}
                  </p>
                ) : (
                  <p className="border-t border-ink-700 pt-2.5 text-[11px] text-amber-400/80">
                    No knowledge base match — add facts in Knowledge base so answers stop being generic.
                  </p>
                )}
                {testResult.draft.reasoning ? <p className="text-[11px] leading-relaxed text-mist-400">{testResult.draft.reasoning}</p> : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

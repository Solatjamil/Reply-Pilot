'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from './icons'
import { Badge, EmptyState, Field } from './ui'

export interface KnowledgeRow {
  id: string
  kind: string
  title: string
  question: string | null
  body: string
  tags: string
  url: string | null
  weight: number
  enabled: boolean
  embedding: string | null
  updatedAt: string
}

export interface RuleRow {
  id: string
  kind: string
  pattern: string
  matchType: string
  response: string | null
  priority: number
  enabled: boolean
  accountId: string | null
  account?: { id: string; name: string; platform: string } | null
}

const KINDS = [
  { id: 'faq', label: 'FAQ' },
  { id: 'policy', label: 'Policy' },
  { id: 'product', label: 'Product / price' },
  { id: 'url', label: 'Link' },
  { id: 'doc', label: 'Document' },
]

const RULE_KINDS = [
  { id: 'guaranteed_answer', label: 'Guaranteed answer', hint: 'When this phrase appears, ReplyPilot must convey this exact answer (prices, hours, links).' },
  { id: 'escalate_keyword', label: 'Always escalate', hint: 'Never auto-send — a human must approve.' },
  { id: 'blocklist', label: 'Never reply', hint: 'Skip these comments entirely.' },
  { id: 'competitor', label: 'Competitor mention', hint: 'Escalate when a competitor is named.' },
]

export function KnowledgeClient({
  items,
  rules,
  accounts,
  aiReady,
  embedProvider,
}: {
  items: KnowledgeRow[]
  rules: RuleRow[]
  accounts: { id: string; name: string }[]
  aiReady: boolean
  embedProvider: string | null
}) {
  const router = useRouter()
  const [tab, setTab] = useState<'knowledge' | 'rules'>('knowledge')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [kForm, setKForm] = useState<Partial<KnowledgeRow> | null>(null)
  const [rForm, setRForm] = useState<Partial<RuleRow> | null>(null)

  const post = async (url: string, body: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`)
        return false
      }
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  const remove = async (url: string, id: string) => {
    setBusy(true)
    await fetch(`${url}?id=${id}`, { method: 'DELETE' })
    setBusy(false)
    router.refresh()
  }

  const parseTags = (raw: string) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
          <button
            onClick={() => setTab('knowledge')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${tab === 'knowledge' ? 'bg-accent-500/15 text-white' : 'text-mist-400 hover:text-mist-200'}`}
          >
            Knowledge base <span className="ml-1 font-mono text-[10px]">{items.length}</span>
          </button>
          <button
            onClick={() => setTab('rules')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${tab === 'rules' ? 'bg-accent-500/15 text-white' : 'text-mist-400 hover:text-mist-200'}`}
          >
            Safety rules <span className="ml-1 font-mono text-[10px]">{rules.length}</span>
          </button>
        </div>
        {error ? <span className="text-xs text-rose-400">{error}</span> : null}
      </div>

      {!aiReady ? (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/8 p-3.5 text-xs text-amber-400/90">
          No embedding provider configured ({embedProvider ?? 'none'}). Knowledge will still be matched by keyword overlap — add an
          OPENAI_API_KEY / GOOGLE_API_KEY for semantic matching.
        </div>
      ) : null}

      {tab === 'knowledge' ? (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-3 lg:col-span-3">
            {items.length === 0 ? (
              <EmptyState
                title="Your knowledge base is empty"
                description="Add shipping costs, opening hours, return policy, product details, booking links. The AI is only allowed to state facts found here — so more entries means fewer escalations."
                icon={<Icon name="knowledge" size={22} />}
              />
            ) : (
              <div className="card divide-y divide-ink-800">
                {items.map((i) => (
                  <div key={i.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="neutral">{KINDS.find((k) => k.id === i.kind)?.label ?? i.kind}</Badge>
                          <span className="text-sm font-medium text-white">{i.title}</span>
                          {i.enabled ? null : <Badge tone="warn">disabled</Badge>}
                          <Badge tone={i.embedding === 'embedded' ? 'good' : 'neutral'}>{i.embedding === 'embedded' ? 'vector indexed' : 'keyword only'}</Badge>
                        </div>
                        {i.question ? <p className="mt-1.5 text-xs text-mist-400">Q: {i.question}</p> : null}
                        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-mist-300">{i.body}</p>
                        {i.url ? (
                          <a href={i.url} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-block text-[11px] text-accent-400 hover:underline">
                            {i.url}
                          </a>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          onClick={() => setKForm({ ...i, tags: parseTagsArray(i.tags).join(', ') })}
                          className="btn-ghost btn-sm"
                          title="Edit"
                        >
                          <Icon name="edit" size={13} />
                        </button>
                        <button onClick={() => remove('/api/knowledge', i.id)} disabled={busy} className="btn-ghost btn-sm text-mist-400 hover:text-rose-400" title="Delete">
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-2">
            <div className="card-pad space-y-4 lg:sticky lg:top-6">
              <h2 className="text-sm font-semibold text-white">{kForm?.id ? 'Edit entry' : 'Add an entry'}</h2>
              <Field label="Type">
                <select className="input" value={kForm?.kind ?? 'faq'} onChange={(e) => setKForm({ ...kForm, kind: e.target.value })}>
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <input className="input" value={kForm?.title ?? ''} onChange={(e) => setKForm({ ...kForm, title: e.target.value })} placeholder="Shipping to Pakistan" />
              </Field>
              <Field label="Customer question (optional)" hint="Phrasing customers actually use improves matching a lot.">
                <input className="input" value={kForm?.question ?? ''} onChange={(e) => setKForm({ ...kForm, question: e.target.value })} placeholder="How much is delivery?" />
              </Field>
              <Field label="The answer / fact">
                <textarea
                  className="input min-h-[110px] leading-relaxed"
                  value={kForm?.body ?? ''}
                  onChange={(e) => setKForm({ ...kForm, body: e.target.value })}
                  placeholder="Flat Rs 250 nationwide, free above Rs 5,000. 2–4 working days via TCS."
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Tags">
                  <input className="input" value={kForm?.tags ?? ''} onChange={(e) => setKForm({ ...kForm, tags: e.target.value })} placeholder="shipping, delivery" />
                </Field>
                <Field label="Link (optional)">
                  <input className="input" value={kForm?.url ?? ''} onChange={(e) => setKForm({ ...kForm, url: e.target.value })} placeholder="https://…" />
                </Field>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    if (!kForm?.title?.trim() || !kForm?.body?.trim()) {
                      setError('Title and the answer text are required.')
                      return
                    }
                    const okSaved = await post('/api/knowledge', {
                      id: kForm.id,
                      kind: kForm.kind ?? 'faq',
                      title: kForm.title,
                      question: kForm.question || null,
                      body: kForm.body,
                      tags: parseTags(kForm.tags ?? ''),
                      url: kForm.url || null,
                      enabled: kForm.enabled ?? true,
                    })
                    if (okSaved) setKForm(null)
                  }}
                  disabled={busy}
                  className="btn-primary flex-1"
                >
                  {kForm?.id ? 'Save changes' : 'Add to knowledge base'}
                </button>
                {kForm ? (
                  <button onClick={() => setKForm(null)} className="btn-ghost">
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-3 lg:col-span-3">
            {rules.length === 0 ? (
              <EmptyState
                title="No safety rules yet"
                description="Guaranteed answers keep prices exact. Escalation keywords route legal, refund and abuse cases to a human. Blocklists silence spam."
                icon={<Icon name="warning" size={22} />}
              />
            ) : (
              <div className="card divide-y divide-ink-800">
                {rules.map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={r.kind === 'blocklist' ? 'bad' : r.kind === 'guaranteed_answer' ? 'good' : 'warn'}>
                          {RULE_KINDS.find((k) => k.id === r.kind)?.label ?? r.kind}
                        </Badge>
                        <code className="font-mono text-xs text-mist-100">{r.pattern}</code>
                        <span className="text-[11px] text-mist-400">{r.matchType.replace('_', ' ')}</span>
                        {r.account ? <Badge tone="neutral">{r.account.name}</Badge> : <Badge tone="neutral">all profiles</Badge>}
                        {r.enabled ? null : <Badge tone="warn">disabled</Badge>}
                      </div>
                      {r.response ? <p className="mt-1.5 text-xs leading-relaxed text-mist-300">→ {r.response}</p> : null}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button onClick={() => setRForm(r)} className="btn-ghost btn-sm" title="Edit">
                        <Icon name="edit" size={13} />
                      </button>
                      <button onClick={() => remove('/api/safety-rules', r.id)} disabled={busy} className="btn-ghost btn-sm text-mist-400 hover:text-rose-400">
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-2">
            <div className="card-pad space-y-4 lg:sticky lg:top-6">
              <h2 className="text-sm font-semibold text-white">{rForm?.id ? 'Edit rule' : 'Add a rule'}</h2>
              <Field label="Rule type">
                <select className="input" value={rForm?.kind ?? 'guaranteed_answer'} onChange={(e) => setRForm({ ...rForm, kind: e.target.value })}>
                  {RULE_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="-mt-2 text-[11px] text-mist-400">{RULE_KINDS.find((k) => k.id === (rForm?.kind ?? 'guaranteed_answer'))?.hint}</p>
              <Field label="Matches when the comment contains">
                <input className="input" value={rForm?.pattern ?? ''} onChange={(e) => setRForm({ ...rForm, pattern: e.target.value })} placeholder="price, kitna, shipping cost" />
              </Field>
              <Field label="Match type">
                <select className="input" value={rForm?.matchType ?? 'contains'} onChange={(e) => setRForm({ ...rForm, matchType: e.target.value })}>
                  <option value="contains">contains</option>
                  <option value="whole_word">whole word</option>
                  <option value="exact">exact text</option>
                  <option value="regex">regular expression</option>
                </select>
              </Field>
              {rForm?.kind === 'guaranteed_answer' ? (
                <Field label="The answer that must be given">
                  <textarea className="input min-h-[90px]" value={rForm?.response ?? ''} onChange={(e) => setRForm({ ...rForm, response: e.target.value })} placeholder="Rs 250 flat, free over Rs 5,000." />
                </Field>
              ) : null}
              <Field label="Applies to">
                <select className="input" value={rForm?.accountId ?? ''} onChange={(e) => setRForm({ ...rForm, accountId: e.target.value || null })}>
                  <option value="">All profiles</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    if (!rForm?.pattern?.trim()) {
                      setError('A pattern is required.')
                      return
                    }
                    const okSaved = await post('/api/safety-rules', {
                      id: rForm.id,
                      kind: rForm.kind ?? 'guaranteed_answer',
                      pattern: rForm.pattern,
                      matchType: rForm.matchType ?? 'contains',
                      response: rForm.response || null,
                      accountId: rForm.accountId || null,
                      enabled: rForm.enabled ?? true,
                    })
                    if (okSaved) setRForm(null)
                  }}
                  disabled={busy}
                  className="btn-primary flex-1"
                >
                  {rForm?.id ? 'Save rule' : 'Add rule'}
                </button>
                {rForm ? (
                  <button onClick={() => setRForm(null)} className="btn-ghost">
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function parseTagsArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

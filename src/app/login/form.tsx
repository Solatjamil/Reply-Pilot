'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function LoginForm({ bootstrapEmail, bootstrapPassword }: { bootstrapEmail: string; bootstrapPassword: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState(bootstrapEmail)
  const [password, setPassword] = useState(bootstrapPassword)
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, workspaceName: workspace }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? `Sign-in failed (${res.status})`)
        return
      }
      router.push('/')
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-pad space-y-4">
      <div className="flex rounded-lg border border-ink-700 bg-ink-950 p-0.5">
        {(['login', 'signup'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m)
              setError(null)
              if (m === 'signup') {
                setEmail('')
                setPassword('')
              }
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === m ? 'bg-accent-500/15 text-white' : 'text-mist-400 hover:text-mist-200'
            }`}
          >
            {m === 'login' ? 'Sign in' : 'Create workspace'}
          </button>
        ))}
      </div>

      {error ? <p className="rounded-lg border border-rose-400/30 bg-rose-400/8 p-2.5 text-xs text-rose-400">{error}</p> : null}

      {mode === 'signup' ? (
        <>
          <div>
            <label className="label">Your name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" />
          </div>
          <div>
            <label className="label">Workspace / brand name</label>
            <input className="input" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Acme Coffee" />
          </div>
        </>
      ) : null}

      <div>
        <label className="label">Email</label>
        <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brand.com" autoComplete="email" />
      </div>
      <div>
        <label className="label">Password</label>
        <input
          className="input"
          type="password"
          required
          minLength={mode === 'signup' ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </div>

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
      </button>

      {mode === 'login' ? (
        <p className="text-center text-[11px] leading-relaxed text-mist-400">
          First run? The bootstrap admin is pre-filled — credentials come from{' '}
          <code className="font-mono text-mist-300">BOOTSTRAP_EMAIL</code> / <code className="font-mono text-mist-300">BOOTSTRAP_PASSWORD</code> in{' '}
          <code className="font-mono">.env</code>. Change them before deploying.
        </p>
      ) : null}
    </form>
  )
}

import type { ReactNode } from 'react'
import { PlatformIcon } from './icons'

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'border-ink-600 bg-ink-800 text-mist-300',
    good: 'border-mint-500/30 bg-mint-500/10 text-mint-400',
    warn: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
    bad: 'border-rose-400/30 bg-rose-400/10 text-rose-400',
    info: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
    accent: 'border-accent-500/30 bg-accent-500/10 text-accent-400',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]} ${className}`}>
      {children}
    </span>
  )
}

export function ConfidenceBar({ value, threshold }: { value: number; threshold?: number }) {
  const pct = Math.round(value * 100)
  const tone = value >= (threshold ?? 0.82) ? 'bg-mint-500' : value >= 0.55 ? 'bg-amber-400' : 'bg-rose-400'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] text-mist-400">{pct}%</span>
    </div>
  )
}

export function Avatar({ name, url, platform, size = 36 }: { name?: string | null; url?: string | null; platform?: string; size?: number }) {
  const initials = (name || '?')
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name ?? ''} className="h-full w-full rounded-full object-cover" style={{ width: size, height: size }} />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-ink-600 to-ink-800 text-xs font-semibold text-mist-200"
          style={{ width: size, height: size }}
        >
          {initials || '?'}
        </div>
      )}
      {platform ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-ink-950 p-0.5"
          style={{ width: size * 0.45, height: size * 0.45 }}
        >
          <PlatformIcon platform={platform} size={size * 0.32} className="text-mist-300" />
        </span>
      ) : null}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'
  icon?: ReactNode
}) {
  const accents: Record<string, string> = {
    neutral: 'text-white',
    good: 'text-mint-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400',
    accent: 'text-accent-400',
  }
  return (
    <div className="card-pad">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-mist-400">{label}</div>
          <div className={`mt-2 text-2xl font-semibold tabular-nums ${accents[tone]}`}>{value}</div>
          {hint ? <div className="mt-1 truncate text-xs text-mist-400">{hint}</div> : null}
        </div>
        {icon ? <div className="text-mist-400">{icon}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="card-pad flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ink-800 text-mist-400">
        {icon ?? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 14H4V8l8 5 8-5v10Z" />
          </svg>
        )}
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {description ? <p className="mt-1.5 max-w-md text-sm text-mist-400">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-mist-100">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-mist-400">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent-500' : 'bg-ink-600'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
        />
      </button>
    </label>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-mist-400">{hint}</p> : null}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-300">{children}</h2>
      {action}
    </div>
  )
}

export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  const units: [number, string][] = [
    [60_000, 'min'],
    [3_600_000, 'hr'],
    [86_400_000, 'day'],
  ]
  if (abs < 45_000) return future ? 'in a moment' : 'just now'
  if (abs < 3_600_000) {
    const v = Math.round(abs / 60_000)
    return future ? `in ${v}m` : `${v}m ago`
  }
  if (abs < 86_400_000) {
    const v = Math.round(abs / 3_600_000)
    return future ? `in ${v}h` : `${v}h ago`
  }
  if (abs < 7 * 86_400_000) {
    const v = Math.round(abs / 86_400_000)
    return future ? `in ${v}d` : `${v}d ago`
  }
  void units
  return d.toLocaleDateString()
}

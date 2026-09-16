'use client'

import { useState } from 'react'
import { PlatformIcon } from './icons'
import type { PlatformMeta } from '@/lib/platforms/catalog'

export function ConnectButton({ platform, configured, missingLabel }: { platform: PlatformMeta; configured: boolean; missingLabel: string }) {
  const [loading, setLoading] = useState(false)

  const providerMap: Record<string, string> = {
    facebook_page: 'meta',
    instagram: 'meta',
    messenger: 'meta',
    youtube: 'google',
    linkedin_org: 'linkedin',
    linkedin_person: 'linkedin',
    x: 'x',
    tiktok: 'tiktok',
  }

  const onClick = () => {
    if (!configured) return
    setLoading(true)
    // Full-page navigation on purpose: this is a server route that 302s to the
    // platform's OAuth consent screen, not an internal Next.js page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/oauth/${providerMap[platform.id] ?? platform.id}/start`
  }

  const gated = platform.capabilities.requiresAccessRequest?.length

  return (
    <div className="card group relative flex flex-col p-4 transition-colors hover:border-ink-600">
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${platform.color}1f`, color: platform.id === 'x' || platform.id === 'tiktok' ? '#e7eaf2' : platform.color }}
        >
          <PlatformIcon platform={platform.id} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">{platform.label}</div>
          <div className="mt-0.5 flex flex-wrap gap-1.5">
            <Cap on={platform.capabilities.readComments && platform.capabilities.replyToComment} label="comments" />
            <Cap on={platform.capabilities.readDms && platform.capabilities.sendDm} label="DMs" />
            <Cap on={platform.capabilities.privateReplyFromComment} label="comment→DM" />
            <Cap on={platform.capabilities.webhooks} label="realtime" />
          </div>
        </div>
      </div>

      {gated ? (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] leading-relaxed text-amber-400/90">
          {platform.capabilities.requiresAccessRequest?.[0]}
        </p>
      ) : null}

      {platform.capabilities.notes?.length ? (
        <ul className="mt-2 space-y-1">
          {platform.capabilities.notes.slice(0, 2).map((n) => (
            <li key={n} className="text-[11px] leading-relaxed text-mist-400">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}

      <button onClick={onClick} disabled={!configured || loading} className={`mt-4 w-full ${configured ? 'btn-ghost group-hover:border-accent-500/50' : 'btn-ghost opacity-50'}`}>
        {loading ? 'Opening…' : configured ? `Attach ${platform.short}` : 'Credentials missing'}
      </button>
      {!configured ? <p className="mt-2 text-center text-[11px] text-mist-400">{missingLabel}</p> : null}
    </div>
  )
}

function Cap({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${on ? 'border-mint-500/30 bg-mint-500/10 text-mint-400' : 'border-ink-600 bg-ink-800 text-mist-400/60 line-through'}`}>
      {label}
    </span>
  )
}

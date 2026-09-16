'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PlatformIcon, Icon } from './icons'
import { Avatar, Badge, relativeTime } from './ui'
import type { PlatformCapabilities } from '@/lib/platforms/catalog'

export interface AccountRowData {
  id: string
  platform: string
  name: string
  handle: string | null
  avatarUrl: string | null
  profileUrl: string | null
  status: string
  lastError: string | null
  lastSyncAt: Date | string | null
  connectedAt: Date | string
  expiresAt: Date | string | null
  tokenPreview: string
  capabilities: PlatformCapabilities
  automation: { replyToComments: boolean; replyToDms: boolean; autoSendEnabled: boolean; autoSendThreshold: number } | null
  stats: { comments: number; drafts: number; pending: number }
}

export function AccountRow({ account }: { account: AccountRowData }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const act = async (action: string, method: 'POST' | 'DELETE' = 'POST') => {
    setBusy(action)
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ action }) : undefined,
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        alert(json.error ?? `Request failed (${res.status})`)
        return
      }
      if (action === 'delete') router.push('/accounts?ok=disconnected')
      else router.refresh()
    } finally {
      setBusy(null)
      setConfirmDelete(false)
    }
  }

  const caps = account.capabilities
  const canComment = caps?.readComments && caps?.replyToComment
  const canDm = caps?.readDms && caps?.sendDm

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={account.name} url={account.avatarUrl} platform={account.platform} size={44} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">{account.name}</span>
            {account.handle ? <span className="text-xs text-mist-400">{account.handle}</span> : null}
            <StatusBadge status={account.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mist-400">
            <span className="inline-flex items-center gap-1">
              <PlatformIcon platform={account.platform} size={12} /> {account.platform.replace('_', ' ')}
            </span>
            <span>{account.stats.comments} comments ingested</span>
            <span>{account.stats.drafts} AI replies</span>
            {account.stats.pending > 0 ? <span className="text-amber-400">{account.stats.pending} awaiting approval</span> : null}
            <span>synced {relativeTime(account.lastSyncAt) || 'never'}</span>
            {account.expiresAt ? <span>token expires {new Date(account.expiresAt).toLocaleDateString()}</span> : null}
          </div>

          {account.lastError ? (
            <p className="mt-2.5 rounded-lg border border-rose-400/25 bg-rose-400/8 p-2.5 text-[11px] leading-relaxed text-rose-400/90">
              {account.lastError}
            </p>
          ) : null}

          {!canComment || !canDm ? (
            <p className="mt-2.5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5 text-[11px] leading-relaxed text-amber-400/85">
              {caps?.requiresAccessRequest?.[0] ?? caps?.notes?.[0] ?? 'Some capabilities are not available for this platform/API tier.'}{' '}
              <a href="/settings#platform-access" className="underline decoration-dotted">Setup details →</a>
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone={account.automation?.replyToComments || account.automation?.replyToDms ? 'good' : 'neutral'}>
            {account.automation?.replyToComments && account.automation?.replyToDms
              ? 'comments + DMs'
              : account.automation?.replyToComments
                ? 'comments only'
                : account.automation?.replyToDms
                  ? 'DMs only'
                  : 'automation off'}
          </Badge>
          <button onClick={() => act('sync')} disabled={busy !== null} className="btn-ghost btn-sm" title="Pull the latest posts, comments and DMs now">
            <Icon name="refresh" size={14} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          {account.status === 'error' ? (
            <button onClick={() => act('retry')} disabled={busy !== null} className="btn-ghost btn-sm">
              {busy === 'retry' ? '…' : 'Retry'}
            </button>
          ) : null}
          <a href="/automations" className="btn-ghost btn-sm">
            <Icon name="automation" size={14} /> Rules
          </a>
          {confirmDelete ? (
            <span className="flex items-center gap-1.5">
              <button onClick={() => act('delete', 'DELETE')} disabled={busy !== null} className="btn-danger btn-sm">
                Confirm
              </button>
              <button onClick={() => setConfirmDelete(false)} className="btn-ghost btn-sm">
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="btn-ghost btn-sm text-mist-400 hover:text-rose-400" title="Disconnect">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge tone="good"><span className="pulse-dot">●</span> connected</Badge>
  if (status === 'pending_access') return <Badge tone="warn">access pending</Badge>
  if (status === 'error') return <Badge tone="bad">needs attention</Badge>
  if (status === 'revoked') return <Badge tone="neutral">revoked</Badge>
  return <Badge>{status}</Badge>
}

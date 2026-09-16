'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon, Logo } from './icons'
import { Badge } from './ui'

const NAV = [
  { href: '/', label: 'Dashboard', icon: 'dashboard' },
  { href: '/inbox', label: 'Inbox & approvals', icon: 'inbox' },
  { href: '/accounts', label: 'Connected profiles', icon: 'accounts' },
  { href: '/automations', label: 'Automation rules', icon: 'automation' },
  { href: '/brand', label: 'Brand voice', icon: 'voice' },
  { href: '/knowledge', label: 'Knowledge base', icon: 'knowledge' },
  { href: '/analytics', label: 'Analytics', icon: 'analytics' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
  { href: '/logs', label: 'Activity log', icon: 'logs' },
]

export function Sidebar({
  workspaceName,
  email,
  pendingCount,
}: {
  workspaceName: string
  email: string
  pendingCount: number
}) {
  const pathname = usePathname()

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-950/60 backdrop-blur">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <Logo size={30} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">ReplyPilot</div>
          <div className="truncate text-[11px] text-mist-400">{workspaceName}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active ? 'bg-accent-500/12 text-white' : 'text-mist-300 hover:bg-ink-800/70 hover:text-white'
              }`}
            >
              <span className={active ? 'text-accent-400' : 'text-mist-400 group-hover:text-mist-200'}>
                <Icon name={item.icon} size={17} />
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.href === '/inbox' && pendingCount > 0 ? (
                <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{pendingCount}</span>
              ) : null}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-ink-800 p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent-500 to-mint-500 text-xs font-bold text-white">
            {email.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-mist-100">{email}</div>
            <Badge tone="neutral" className="mt-0.5">owner</Badge>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="rounded-md p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-rose-400" title="Log out">
              <Icon name="logout" size={16} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  )
}

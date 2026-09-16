import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Sidebar } from '@/components/sidebar'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  const workspace = await prisma.workspace.findUnique({ where: { id: session.wid } })
  if (!workspace) redirect('/login')

  const pendingCount = await prisma.draft.count({
    where: { workspaceId: workspace.id, status: 'pending', action: { in: ['review', 'escalate'] } },
  })

  return (
    <div className="flex min-h-screen">
      <Sidebar workspaceName={workspace.name} email={session.email} pendingCount={pendingCount} />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-6 py-7 lg:px-9">{children}</div>
      </main>
    </div>
  )
}

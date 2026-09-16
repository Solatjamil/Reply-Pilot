import Link from 'next/link'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { decryptJson } from '@/lib/crypto'
import { PendingConnection, type PendingProfile } from '@/components/pending-connection'

export const dynamic = 'force-dynamic'

interface PendingPayload {
  provider: string
  profiles: PendingProfile[]
}

export default async function PendingConnectionPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const session = await getSession()
  if (!session) redirect('/login')
  const { id } = await searchParams
  if (!id) redirect('/accounts')

  const pending = await prisma.job.findFirst({ where: { id, workspaceId: session.wid } })
  if (!pending) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-xl font-semibold text-white">This connection session is gone</h1>
        <p className="muted mt-2 text-sm">It may have expired or already been used.</p>
        <Link href="/accounts" className="btn-primary mt-6">Back to profiles</Link>
      </div>
    )
  }

  const payload = decryptJson<PendingPayload>(pending.payload)
  if (!payload?.profiles?.length) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-xl font-semibold text-white">No profiles in this session</h1>
        <p className="muted mt-2 text-sm">The provider returned an empty list. Reconnect and make sure the right permissions were granted.</p>
        <Link href="/accounts" className="btn-primary mt-6">Back to profiles</Link>
      </div>
    )
  }

  return (
    <PendingConnection
      jobId={pending.id}
      provider={payload.provider}
      profiles={payload.profiles}
      expiresAt={(pending.runAt ?? new Date()).toISOString()}
    />
  )
}

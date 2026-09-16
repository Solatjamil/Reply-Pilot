import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { LoginForm } from './form'
import { Logo } from '@/components/icons'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sign in · ReplyPilot' }

export default async function LoginPage() {
  const session = await getSession()
  if (session) redirect('/')
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={44} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">ReplyPilot</h1>
          <p className="muted mt-1.5 text-sm">AI comment &amp; DM autopilot for every social profile</p>
        </div>
        <LoginForm
          bootstrapEmail={process.env.BOOTSTRAP_EMAIL ?? 'admin@replypilot.local'}
          bootstrapPassword={process.env.BOOTSTRAP_PASSWORD ?? 'replypilot123'}
        />
      </div>
    </div>
  )
}



function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required environment variable: ${name}`)
  return v
}

function opt(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

export type AiProvider = 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter' | 'ollama'

export const env = {
  get appUrl() {
    return opt('APP_URL', 'http://localhost:3000').replace(/\/$/, '')
  },
  get appSecret() {
    return opt('APP_SECRET', 'dev-insecure-app-secret-change-me-32')
  },
  get authSecret() {
    return opt('AUTH_SECRET', 'dev-insecure-auth-secret-change-me')
  },
  get databaseUrl() {
    return opt('DATABASE_URL', 'file:./dev.db')
  },
  bootstrap: {
    email: opt('BOOTSTRAP_EMAIL', 'admin@replypilot.local'),
    password: opt('BOOTSTRAP_PASSWORD', 'replypilot123'),
    workspace: opt('BOOTSTRAP_WORKSPACE', 'My Brand'),
  },

  ai: {
    get provider(): AiProvider {
      return (opt('AI_PROVIDER', 'openai') as AiProvider) || 'openai'
    },
    get model() {
      return opt('AI_MODEL', 'gpt-4o-mini')
    },
    get embedModel() {
      return opt('EMBED_MODEL', 'text-embedding-3-small')
    },
  },

  meta: {
    get appId() {
      return opt('META_APP_ID')
    },
    get appSecret() {
      return opt('META_APP_SECRET')
    },
    get verifyToken() {
      return opt('META_VERIFY_TOKEN', 'replypilot-meta-verify')
    },
    get version() {
      return opt('META_API_VERSION', 'v23.0')
    },
    /** Instagram Login with Instagram API (separate from Facebook Login). */
    get igClientId() {
      return opt('IG_CLIENT_ID')
    },
    get igClientSecret() {
      return opt('IG_CLIENT_SECRET')
    },
    get configured() {
      return Boolean(this.appId && this.appSecret)
    },
    get igConfigured() {
      return Boolean(this.igClientId && this.igClientSecret)
    },
  },

  tiktok: {
    get clientKey() {
      return opt('TIKTOK_CLIENT_KEY')
    },
    get clientSecret() {
      return opt('TIKTOK_CLIENT_SECRET')
    },
    get verifyToken() {
      return opt('TIKTOK_VERIFY_TOKEN', 'replypilot-tiktok-verify')
    },
    get configured() {
      return Boolean(this.clientKey && this.clientSecret)
    },
  },

  google: {
    get clientId() {
      return opt('GOOGLE_CLIENT_ID')
    },
    get clientSecret() {
      return opt('GOOGLE_CLIENT_SECRET')
    },
    get youtubeApiKey() {
      return opt('YOUTUBE_API_KEY')
    },
    get configured() {
      return Boolean(this.clientId && this.clientSecret)
    },
  },

  linkedin: {
    get clientId() {
      return opt('LINKEDIN_CLIENT_ID')
    },
    get clientSecret() {
      return opt('LINKEDIN_CLIENT_SECRET')
    },
    get verifyToken() {
      return opt('LINKEDIN_VERIFY_TOKEN', 'replypilot-linkedin-verify')
    },
    get configured() {
      return Boolean(this.clientId && this.clientSecret)
    },
  },

  x: {
    get clientId() {
      return opt('X_CLIENT_ID')
    },
    get clientSecret() {
      return opt('X_CLIENT_SECRET')
    },
    get apiKey() {
      return opt('X_API_KEY')
    },
    get apiKeySecret() {
      return opt('X_API_KEY_SECRET')
    },
    get bearerToken() {
      return opt('X_BEARER_TOKEN')
    },
    get configured() {
      return Boolean(this.clientId && this.clientSecret)
    },
  },

  worker: {
    get concurrency() {
      return Number(opt('WORKER_CONCURRENCY', '4'))
    },
    get pollIntervalSeconds() {
      return Number(opt('POLL_INTERVAL_SECONDS', '120'))
    },
    get inProcess() {
      return opt('ENABLE_INPROC_WORKER', '1') === '1'
    },
  },

  /** Same as the top-level `require` helper, kept out of the object to avoid clobbering `worker`. */
}

export function requireEnv(name: string): string {
  return req(name)
}

/** Which platform integrations have credentials present. Drives the setup page. */
export function configuredPlatforms() {
  return [
    { id: 'meta', label: 'Meta (Facebook Pages, Instagram, Messenger)', ok: env.meta.configured || env.meta.igConfigured },
    { id: 'google', label: 'Google / YouTube', ok: env.google.configured || Boolean(env.google.youtubeApiKey) },
    { id: 'linkedin', label: 'LinkedIn', ok: env.linkedin.configured },
    { id: 'x', label: 'X (Twitter)', ok: env.x.configured },
    { id: 'tiktok', label: 'TikTok', ok: env.tiktok.configured },
  ]
}

export function aiConfigured(): boolean {
  if (process.env.AI_MOCK === '1') return true
  switch (env.ai.provider) {
    case 'anthropic':
      return Boolean(process.env.ANTHROPIC_API_KEY)
    case 'google':
      return Boolean(process.env.GOOGLE_API_KEY)
    case 'groq':
      return Boolean(process.env.GROQ_API_KEY)
    case 'openrouter':
      return Boolean(process.env.OPENROUTER_API_KEY)
    case 'ollama':
      return true
    default:
      return Boolean(process.env.OPENAI_API_KEY)
  }
}

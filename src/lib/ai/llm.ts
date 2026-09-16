
import { env } from '@/lib/env'
import { ApiError, http } from '@/lib/http'
import { mockChat, mockProviderEnabled } from './mock-provider'

export interface LlmUsage {
  promptTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult<T = unknown> {
  data: T
  raw: string
  provider: string
  model: string
  usage: LlmUsage
  latencyMs: number
}

export class LlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'LlmError'
  }
}

interface ProviderConfig {
  id: string
  baseUrl: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  /** Converts our ChatMessage[] into the provider's body shape. */
  buildBody(messages: ChatMessage[], opts: { json: boolean; temperature: number; maxTokens: number }): unknown
  /** Pulls text + usage out of the provider response. */
  parse(body: unknown): { text: string; usage: LlmUsage }
  maxTokensCap: number
}

// Rough per-1M-token pricing used only for the cost column in analytics.
// Update these numbers for your negotiated rates.
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
}

function costOf(model: string, usage: LlmUsage): number {
  const key = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k) || k.includes(model.toLowerCase()))
  if (!key) return 0
  const p = PRICING[key]
  return ((usage.promptTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1_000_000
}

export function providerConfigs(): ProviderConfig[] {
  const primary = env.ai.provider
  const all: ProviderConfig[] = []

  if (process.env.OPENAI_API_KEY) {
    all.push({
      id: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: primary === 'openai' ? env.ai.model : 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      maxTokensCap: 4096,
      buildBody: (messages, o) => ({
        model: undefined, // filled by caller
        messages,
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      parse: (body) => {
        const b = body as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        return {
          text: b.choices?.[0]?.message?.content ?? '',
          usage: { promptTokens: b.usage?.prompt_tokens, outputTokens: b.usage?.completion_tokens },
        }
      },
    })
  }

  if (process.env.ANTHROPIC_API_KEY) {
    all.push({
      id: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: primary === 'anthropic' ? process.env.ANTHROPIC_MODEL || env.ai.model : 'claude-haiku-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxTokensCap: 4096,
      headers: { 'anthropic-version': '2023-06-01' },
      buildBody: (messages, o) => ({
        system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        temperature: o.temperature,
        max_tokens: o.maxTokens,
      }),
      parse: (body) => {
        const b = body as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }
        return {
          text: (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
          usage: { promptTokens: b.usage?.input_tokens, outputTokens: b.usage?.output_tokens },
        }
      },
    })
  }

  if (process.env.GOOGLE_API_KEY) {
    all.push({
      id: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: primary === 'google' ? process.env.GOOGLE_MODEL || env.ai.model : 'gemini-2.0-flash',
      apiKey: process.env.GOOGLE_API_KEY,
      maxTokensCap: 4096,
      buildBody: (messages, o) => ({
        systemInstruction: { parts: [{ text: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') }] },
        contents: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: {
          temperature: o.temperature,
          maxOutputTokens: o.maxTokens,
          ...(o.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      parse: (body) => {
        const b = body as {
          candidates?: { content?: { parts?: { text?: string }[] } }[]
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        }
        return {
          text: (b.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
          usage: { promptTokens: b.usageMetadata?.promptTokenCount, outputTokens: b.usageMetadata?.candidatesTokenCount },
        }
      },
    })
  }

  if (process.env.GROQ_API_KEY) {
    all.push({
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: primary === 'groq' ? process.env.GROQ_MODEL || env.ai.model : 'llama-3.3-70b-versatile',
      apiKey: process.env.GROQ_API_KEY,
      maxTokensCap: 2048,
      buildBody: (messages, o) => ({
        messages,
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      parse: (body) => {
        const b = body as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        return {
          text: b.choices?.[0]?.message?.content ?? '',
          usage: { promptTokens: b.usage?.prompt_tokens, outputTokens: b.usage?.completion_tokens },
        }
      },
    })
  }

  if (process.env.OPENROUTER_API_KEY) {
    all.push({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: primary === 'openrouter' ? process.env.OPENROUTER_MODEL || env.ai.model : 'openai/gpt-4o-mini',
      apiKey: process.env.OPENROUTER_API_KEY,
      maxTokensCap: 4096,
      headers: { 'HTTP-Referer': env.appUrl, 'X-Title': 'ReplyPilot' },
      buildBody: (messages, o) => ({
        messages,
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      parse: (body) => {
        const b = body as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        return {
          text: b.choices?.[0]?.message?.content ?? '',
          usage: { promptTokens: b.usage?.prompt_tokens, outputTokens: b.usage?.completion_tokens },
        }
      },
    })
  }

  // Ollama needs no key — used when explicitly selected, or as a last resort.
  if (primary === 'ollama' || all.length === 0) {
    all.push({
      id: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.1',
      maxTokensCap: 2048,
      buildBody: (messages, o) => ({
        messages,
        stream: false,
        options: { temperature: o.temperature, num_predict: o.maxTokens },
        ...(o.json ? { format: 'json' } : {}),
      }),
      parse: (body) => {
        const b = body as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
        return {
          text: b.message?.content ?? '',
          usage: { promptTokens: b.prompt_eval_count, outputTokens: b.eval_count },
        }
      },
    })
  }

  // Put the configured primary first so it wins.
  return [...all].sort((a, b) => (a.id === primary ? -1 : b.id === primary ? 1 : 0))
}

export interface ChatOptions {
  json?: boolean
  temperature?: number
  maxTokens?: number
  /** Force a specific provider id. */
  provider?: string
  /** Extra fallback providers to try, in order. Defaults to all configured. */
  fallbacks?: boolean
}

/**
 * Provider-agnostic chat completion with automatic failover.
 * When `json` is true the result is parsed into an object.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (mockProviderEnabled()) return mockChat(messages, opts.json ?? false)
  const configs = providerConfigs()
  if (opts.provider) {
    const sorted = [...configs].sort((a, b) => (a.id === opts.provider ? -1 : b.id === opts.provider ? 1 : 0))
    configs.splice(0, configs.length, ...sorted)
  }
  const configured = configs.filter((c) => c.id !== 'ollama')
  if (configured.length === 0) {
    throw new LlmError(
      'No AI provider is configured. Add one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY to .env and restart the server. ' +
        '(AI_PROVIDER=ollama also works if you run a local model.)',
    )
  }

  const errors: string[] = []
  const tryList = opts.fallbacks === false ? configs.slice(0, 1) : configs

  for (const cfg of tryList) {
    const started = Date.now()
    try {
      const url =
        cfg.id === 'google'
          ? `${cfg.baseUrl}/models/${cfg.model}:generateContent`
          : cfg.id === 'anthropic'
            ? `${cfg.baseUrl}/messages`
            : cfg.id === 'ollama'
              ? `${cfg.baseUrl}/api/chat`
              : `${cfg.baseUrl}/chat/completions`

      const body = cfg.buildBody(messages, {
        json: opts.json ?? false,
        temperature: opts.temperature ?? 0.6,
        maxTokens: Math.min(opts.maxTokens ?? 700, cfg.maxTokensCap),
      }) as Record<string, unknown>

      if (cfg.id !== 'google' && cfg.id !== 'ollama') body.model = cfg.model

      const res = await http<unknown>(url, {
        method: 'POST',
        json: body,
        headers: {
          ...(cfg.apiKey
            ? cfg.id === 'anthropic'
              ? { 'x-api-key': cfg.apiKey }
              : { Authorization: `Bearer ${cfg.apiKey}` }
            : {}),
          ...(cfg.id === 'google' && cfg.apiKey ? { 'x-goog-api-key': cfg.apiKey } : {}),
          ...cfg.headers,
        },
        timeoutMs: 60_000,
        retries: 2,
        skipLimiter: cfg.id === 'ollama',
        rateScope: `llm:${cfg.id}`,
        ratePerSec: 5,
        rateBurst: 10,
      })

      const parsed = cfg.parse(res)
      if (!parsed.text?.trim()) throw new LlmError(`${cfg.id} returned an empty completion`)
      const usage: LlmUsage = { ...parsed.usage }
      usage.costUsd = costOf(cfg.model, usage)

      return {
        data: opts.json ? parseJsonLoose(parsed.text) : parsed.text,
        raw: parsed.text,
        provider: cfg.id,
        model: cfg.model,
        usage,
        latencyMs: Date.now() - started,
      }
    } catch (err) {
      const msg = err instanceof ApiError ? `${cfg.id}: ${err.message} ${JSON.stringify(err.body).slice(0, 300)}` : `${cfg.id}: ${(err as Error).message}`
      errors.push(msg)
      // Auth/billing problems: try the next provider. Bad request: don't.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) continue
      continue
    }
  }

  const hint = configured.length === 0 ? '\nNo cloud provider key is set, so only the local Ollama fallback was attempted.' : ''
  throw new LlmError(`All AI providers failed:${hint}\n${errors.join('\n')}`)
}

/** Extracts a JSON object even when the model wraps it in prose or fences. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [trimmed, fenced?.[1]?.trim() ?? ''].filter(Boolean)

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T
    } catch {
      /* keep trying */
    }
    const first = c.indexOf('{')
    const last = c.lastIndexOf('}')
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(c.slice(first, last + 1)) as T
      } catch {
        /* keep trying */
      }
    }
  }
  throw new LlmError(`Could not parse JSON from model output: ${trimmed.slice(0, 300)}`)
}

/**
 * Embeddings. Uses OpenAI/Google/Ollama when available; otherwise returns null
 * and the retrieval layer falls back to lexical scoring.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  const key = process.env.OPENAI_API_KEY
  const googleKey = process.env.GOOGLE_API_KEY

  try {
    if (key) {
      const res = await http<{ data: { embedding: number[] }[] }>('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        json: { model: env.ai.embedModel, input: texts },
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 60_000,
      })
      return res.data.map((d) => d.embedding)
    }
    if (googleKey) {
      const out: number[][] = []
      for (const t of texts) {
        const res = await http<{ embedding: { values: number[] } }>(
          `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`,
          {
            method: 'POST',
            json: { content: { parts: [{ text: t }] } },
            headers: { 'x-goog-api-key': googleKey },
            timeoutMs: 60_000,
          },
        )
        out.push(res.embedding.values)
      }
      return out
    }
    if (env.ai.provider === 'ollama') {
      const out: number[][] = []
      for (const t of texts) {
        const res = await http<{ embedding: number[] }>(`${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/api/embeddings`, {
          method: 'POST',
          json: { model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text', prompt: t },
          skipLimiter: true,
          timeoutMs: 60_000,
        })
        out.push(res.embedding)
      }
      return out
    }
  } catch (err) {
    console.warn('[ai] embedding failed, falling back to lexical retrieval:', (err as Error).message)
  }
  return null
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

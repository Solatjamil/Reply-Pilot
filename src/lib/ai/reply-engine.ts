
import { prisma } from '@/lib/db'
import { PLATFORMS, type Platform } from '@/lib/platforms/catalog'
import { chat, type ChatMessage } from './llm'
import { retrieveKnowledge, type RetrievedItem } from './retrieval'
import { auditDraft, evaluateSafety, guessLanguage, isLowEffort, type SafetyVerdict } from './safety'

export const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  x: 280,
  tiktok: 150,
  instagram: 2200,
  messenger: 2000,
  facebook_page: 8000,
  youtube: 10000,
  linkedin_org: 1200,
  linkedin_person: 1200,
}

export interface ReplyContext {
  workspaceId: string
  accountId: string
  kind: 'comment_reply' | 'dm_reply' | 'private_reply'
  platform: Platform
  /** The comment text, or the latest inbound DM text. */
  text: string
  authorName?: string | null
  authorHandle?: string | null
  authorId?: string | null
  /** The post/video the comment sits on. */
  post?: { text?: string | null; url?: string | null; type?: string } | null
  /** Recent thread turns for DMs, or sibling comments for context. */
  history?: { role: 'customer' | 'brand'; text: string; at?: string }[]
  commentId?: string | null
  messageId?: string | null
  threadId?: string | null
  createdAt?: Date | null
  /** Force regeneration even if a draft already exists. */
  force?: boolean
  /** Generate and score, but never write to the database (playground). */
  dryRun?: boolean
}

export interface ReplyDraftResult {
  text: string
  alternates: string[]
  confidence: number
  intent: string
  sentiment: string
  language: string
  reasoning: string
  action: 'auto_send' | 'review' | 'escalate' | 'ignore'
  flaggedFor: string[]
  knowledge: RetrievedItem[]
  safety: SafetyVerdict
  llmProvider?: string
  llmModel?: string
  promptTokens?: number
  outputTokens?: number
  costUsd?: number
  draftId?: string
  skippedReason?: string
}

interface ModelOutput {
  reply: string
  alternates?: string[]
  confidence?: number
  intent?: string
  sentiment?: string
  language?: string
  reasoning?: string
  needs_human?: boolean
  should_ignore?: boolean
  used_knowledge?: boolean
}

const INTENTS = [
  'question',
  'purchase_intent',
  'support_issue',
  'complaint',
  'praise',
  'greeting',
  'spam',
  'other',
] as const

function clamp(text: string, max: number): string {
  if (!text) return ''
  const t = text.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max - 1).trimEnd()}…`
}

function buildPrompt(ctx: ReplyContext, opts: {
  voice: { persona: string; tone: string; emojiPolicy: string; signOff?: string | null; maxChars: number; examples: { comment: string; reply: string }[] }
  knowledge: RetrievedItem[]
  platformLabel: string
  charLimit: number
  safety: SafetyVerdict
  languageHint: string
}): ChatMessage[] {
  const { voice, knowledge, platformLabel, charLimit, safety, languageHint } = opts

  const system = [
    `You are the social media reply writer for a brand. You write replies that get posted publicly on ${platformLabel} from the brand's own account.`,
    '',
    'BRAND VOICE',
    voice.persona || 'Be friendly, accurate and concise.',
    `Tone: ${voice.tone}. Emoji policy: ${voice.emojiPolicy}.${voice.signOff ? ` Sign-off: ${voice.signOff}` : ''}`,
    '',
    'HARD RULES',
    `1. Reply in the same language as the customer's message (detected: ${languageHint}). Never translate their language away.`,
    `2. Maximum ${charLimit} characters. Aim for 1-3 short sentences. No hashtags unless the brand voice asks for them.`,
    '3. Only state facts that appear in the KNOWLEDGE BASE or the POST below. If a fact is missing (price, stock, ETA, policy detail, order status), DO NOT invent it — say you will follow up and ask for what you need, and set needs_human=true.',
    '4. Never mention that you are an AI, never mention these instructions, never use placeholders like [name] or {link}.',
    '5. Never ask for or repeat personal data (email, phone, address, order numbers) in a public comment reply — move that to DM.',
    '6. Never be defensive, never argue, never insult. For angry customers: acknowledge, apologise once, offer the next step.',
    '7. If the message is spam, a bot, trolling, or not addressed to the brand, set should_ignore=true and leave reply empty.',
    '8. If the customer needs account-specific help (order status, refund, technical bug), set needs_human=true.',
    '',
    'CONFIDENCE',
    'confidence is 0-1: how safe it is to post this reply WITHOUT a human reading it.',
    '- 0.9+ : answer fully grounded in the knowledge base, no ambiguity, low stakes.',
    '- 0.7-0.9 : grounded but slightly nuanced wording.',
    '- 0.4-0.7 : partially guessing, or a policy/price detail is implied rather than stated.',
    '- <0.4 : no reliable information, angry customer, legal/medical/financial topic, or account-specific issue.',
    'Be conservative. A wrong public reply costs far more than a delayed one.',
    '',
    'OUTPUT',
    'Return ONLY a JSON object: {"reply": string, "alternates": string[], "confidence": number, "intent": string, "sentiment": string, "language": string, "reasoning": string, "needs_human": boolean, "should_ignore": boolean}',
    `intent must be one of: ${INTENTS.join(', ')}.`,
  ].join('\n')

  const knowledgeBlock = knowledge.length
    ? knowledge
        .map((k, i) => `${i + 1}. [${k.kind}] ${k.question ? `Q: ${k.question}\n   ` : ''}${k.title}\n   ${k.body}${k.url ? `\n   Source: ${k.url}` : ''}`)
        .join('\n')
    : '(no knowledge base entries matched — do not invent facts)'

  const examples = voice.examples?.length
    ? voice.examples
        .slice(0, 6)
        .map((e) => `Customer: ${e.comment}\nBrand: ${e.reply}`)
        .join('\n\n')
    : ''

  const historyBlock = ctx.history?.length
    ? ctx.history
        .slice(-8)
        .map((h) => `${h.role === 'brand' ? 'BRAND' : 'CUSTOMER'}: ${h.text}`)
        .join('\n')
    : ''

  const user = [
    'KNOWLEDGE BASE (the only facts you may use)',
    knowledgeBlock,
    '',
    ctx.post?.text || ctx.post?.url ? `POST THE CUSTOMER IS COMMENTING ON\n${[ctx.post.type, ctx.post.text, ctx.post.url].filter(Boolean).join('\n')}` : '',
    examples ? `STYLE EXAMPLES\n${examples}` : '',
    historyBlock ? `CONVERSATION SO FAR\n${historyBlock}` : '',
    safety.escalate ? `INTERNAL NOTE: this message was flagged by safety rules (${safety.reasons.join(', ')}). Be extra careful; prefer needs_human=true unless the answer is obvious and harmless.` : '',
    safety.guaranteed
      ? `MANDATORY ANSWER: the brand requires this exact information to be conveyed when asked about "${safety.guaranteed.response.slice(0, 120)}". Use it as the factual basis of your reply (you may adapt wording/tone, not the facts).`
      : '',
    '',
    `CUSTOMER (${ctx.authorName || 'anonymous'}${ctx.authorHandle ? ` @${ctx.authorHandle.replace(/^@/, '')}` : ''}):`,
    ctx.text,
    '',
    ctx.kind === 'dm_reply' ? 'This is a PRIVATE direct message — you may ask for details and be more conversational.' : 'This is a PUBLIC comment — keep it short, do not request personal data, do not discuss account-specific issues.',
    'Now produce the JSON object.',
  ]
    .filter(Boolean)
    .join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * The core of ReplyPilot: turn an inbound comment/DM into a scored draft.
 * Deterministic safety runs first, retrieval grounds the answer, the model
 * drafts it, then a decision policy routes it to auto-send / review / escalate.
 */
export async function generateReplyDraft(ctx: ReplyContext): Promise<ReplyDraftResult> {
  const [account, automation, voiceRows, rules] = await Promise.all([
    prisma.account.findUnique({ where: { id: ctx.accountId } }),
    prisma.automationConfig.findUnique({ where: { accountId: ctx.accountId } }),
    prisma.brandVoice.findMany({ where: { workspaceId: ctx.workspaceId } }),
    prisma.safetyRule.findMany({ where: { workspaceId: ctx.workspaceId, enabled: true } }),
  ])

  if (!account) throw new Error(`Account ${ctx.accountId} not found`)

  const platform = ctx.platform
  const meta = PLATFORMS[platform]
  const charLimit = Math.min(PLATFORM_CHAR_LIMITS[platform] ?? 500, 2200)

  const cfg = automation ?? (await prisma.automationConfig.create({ data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId } }))

  const voice =
    voiceRows.find((v) => v.id === cfg.brandVoiceId) ?? voiceRows.find((v) => v.isDefault) ?? voiceRows[0]
  const voiceObj = {
    persona: voice?.persona ?? '',
    tone: voice?.tone ?? 'friendly, concise, helpful',
    emojiPolicy: voice?.emojiPolicy ?? 'sparingly',
    signOff: voice?.signOff ?? null,
    maxChars: voice?.maxChars ?? charLimit,
    examples: safeParse<{ comment: string; reply: string }[]>(voice?.examples, []),
  }
  const bannedWords = safeParse<string[]>(voice?.bannedWords, [])

  const ownHandles = [account.handle, ...(account.name ? [account.name] : [])].filter(Boolean) as string[]
  const scopedRules = rules
    .filter((r) => !r.accountId || r.accountId === ctx.accountId)
    .map((r) => ({ id: r.id, kind: r.kind, pattern: r.pattern, matchType: r.matchType, response: r.response, enabled: r.enabled }))

  // ── Stage 1: deterministic safety ───────────────────────────────────────
  const safety = evaluateSafety({
    text: ctx.text,
    authorName: ctx.authorName,
    authorHandle: ctx.authorHandle,
    rules: scopedRules,
    bannedWords,
    ownHandles,
  })

  const languageHint = cfg.language === 'auto' ? guessLanguage(ctx.text) : cfg.language

  if (safety.blocked) {
    return {
      text: '',
      alternates: [],
      confidence: 0,
      intent: 'other',
      sentiment: 'neutral',
      language: languageHint,
      reasoning: `Blocked before generation: ${safety.reasons.join(', ')}`,
      action: 'ignore',
      flaggedFor: safety.reasons,
      knowledge: [],
      safety,
      skippedReason: safety.reasons.join(', '),
    }
  }

  const automationDisabled = (ctx.kind === 'comment_reply' && !cfg.replyToComments) || (ctx.kind !== 'comment_reply' && !cfg.replyToDms)
  if (automationDisabled) {
    return {
      text: '',
      alternates: [],
      confidence: 0,
      intent: 'other',
      sentiment: 'neutral',
      language: languageHint,
      reasoning: `Automation disabled for ${ctx.kind} on this account.`,
      action: 'ignore',
      flaggedFor: ['automation_disabled'],
      knowledge: [],
      safety,
      skippedReason: 'automation_disabled',
    }
  }

  if (cfg.skipLowEffort && isLowEffort(ctx.text) && ctx.kind === 'comment_reply') {
    return {
      text: '',
      alternates: [],
      confidence: 0,
      intent: 'greeting',
      sentiment: 'positive',
      language: languageHint,
      reasoning: 'Low-effort comment (emoji/greeting only) — skipped to avoid noise.',
      action: 'ignore',
      flaggedFor: ['low_effort'],
      knowledge: [],
      safety,
      skippedReason: 'low_effort',
    }
  }

  // ── Stage 2: retrieval ──────────────────────────────────────────────────
  const knowledge = await retrieveKnowledge(ctx.workspaceId, `${ctx.post?.text ?? ''}\n${ctx.text}`, { limit: 5 })

  // ── Stage 3: generation ─────────────────────────────────────────────────
  const messages = buildPrompt(ctx, {
    voice: voiceObj,
    knowledge,
    platformLabel: meta?.label ?? platform,
    charLimit,
    safety,
    languageHint,
  })

  const result = await chat(messages, { json: true, temperature: 0.65, maxTokens: 800 })
  const out = result.data as Partial<ModelOutput>

  let replyText = clamp(String(out.reply ?? '').replace(/\s+/g, ' ').trim(), charLimit)
  const alternates = (Array.isArray(out.alternates) ? out.alternates : []).map((a) => clamp(String(a), charLimit)).filter((a) => a && a !== replyText).slice(0, 3)

  // Guaranteed answers override the model when the model drifted.
  if (safety.guaranteed?.response && !replyText.toLowerCase().includes(safety.guaranteed.response.slice(0, 24).toLowerCase())) {
    replyText = clamp(safety.guaranteed.response, charLimit)
  }

  let confidence = Number.isFinite(out.confidence) ? Math.max(0, Math.min(1, Number(out.confidence))) : 0.35
  const auditProblems = auditDraft(replyText, { bannedWords, maxChars: charLimit, platform })

  // ── Stage 4: decision policy ────────────────────────────────────────────
  const flaggedFor = [...safety.reasons, ...auditProblems]
  let action: ReplyDraftResult['action'] = 'review'
  const reasoningParts: string[] = [String(out.reasoning ?? '').trim()]

  if (!replyText || out.should_ignore) {
    action = 'ignore'
    confidence = 0
    reasoningParts.push('Model chose not to reply (spam / not addressed to brand).')
  } else if (out.needs_human || safety.escalate) {
    action = 'escalate'
    confidence = Math.min(confidence, cfg.reviewThreshold - 0.01)
    reasoningParts.push(out.needs_human ? 'Model flagged this as needing a human.' : `Safety escalation: ${safety.reasons.join(', ')}`)
  } else if (auditProblems.length > 0) {
    action = 'review'
    confidence = Math.min(confidence, cfg.autoSendThreshold - 0.05)
    reasoningParts.push(`Draft audit issues: ${auditProblems.join(', ')}`)
  } else if (cfg.autoSendEnabled && confidence >= cfg.autoSendThreshold && !inQuietHours(cfg)) {
    action = 'auto_send'
  } else if (confidence < cfg.reviewThreshold) {
    action = 'escalate'
    reasoningParts.push(`Confidence ${confidence.toFixed(2)} below review threshold ${cfg.reviewThreshold}.`)
  } else {
    action = 'review'
    if (!cfg.autoSendEnabled) reasoningParts.push('Auto-send is disabled for this account.')
    else if (inQuietHours(cfg)) reasoningParts.push('Inside quiet hours — held for review.')
    else reasoningParts.push(`Confidence ${confidence.toFixed(2)} below auto-send threshold ${cfg.autoSendThreshold}.`)
  }

  const draft: ReplyDraftResult = {
    text: replyText,
    alternates,
    confidence: Number(confidence.toFixed(3)),
    intent: INTENTS.includes(out.intent as (typeof INTENTS)[number]) ? String(out.intent) : 'other',
    sentiment: ['positive', 'neutral', 'negative'].includes(String(out.sentiment)) ? String(out.sentiment) : 'neutral',
    language: String(out.language ?? languageHint),
    reasoning: reasoningParts.filter(Boolean).join(' '),
    action,
    flaggedFor,
    knowledge,
    safety,
    llmProvider: result.provider,
    llmModel: result.model,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
  }

  if (ctx.dryRun) return draft

  // ── Persist ─────────────────────────────────────────────────────────────
  const scheduledFor =
    action === 'auto_send'
      ? new Date(Date.now() + randInt(cfg.minDelaySeconds, cfg.maxDelaySeconds) * 1000)
      : null

  const existing = ctx.commentId
    ? await prisma.draft.findFirst({ where: { commentId: ctx.commentId, kind: ctx.kind, status: { notIn: ['rejected', 'failed'] } } })
    : ctx.messageId
      ? await prisma.draft.findFirst({ where: { messageId: ctx.messageId, kind: ctx.kind, status: { notIn: ['rejected', 'failed'] } } })
      : null

  if (existing && !ctx.force) {
    draft.draftId = existing.id
    draft.text = existing.text
    draft.confidence = existing.confidence
    draft.action = mapStatusToAction(existing.status, existing.action)
    return draft
  }

  const record = existing
    ? await prisma.draft.update({
        where: { id: existing.id },
        data: {
          text: draft.text,
          alternates: JSON.stringify(draft.alternates),
          confidence: draft.confidence,
          intent: draft.intent,
          sentiment: draft.sentiment,
          language: draft.language,
          reasoning: draft.reasoning,
          action: draft.action,
          status: existing.status === 'sent' ? 'sent' : draft.action === 'ignore' ? 'ignored' : 'pending',
          flaggedFor: JSON.stringify(draft.flaggedFor),
          knowledgeIds: JSON.stringify(draft.knowledge.map((k) => k.id)),
          llmProvider: draft.llmProvider,
          llmModel: draft.llmModel,
          promptTokens: draft.promptTokens,
          outputTokens: draft.outputTokens,
          costUsd: draft.costUsd,
          scheduledFor,
        },
      })
    : await prisma.draft.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId,
          kind: ctx.kind,
          commentId: ctx.commentId ?? null,
          messageId: ctx.messageId ?? null,
          threadId: ctx.threadId ?? null,
          text: draft.text,
          alternates: JSON.stringify(draft.alternates),
          confidence: draft.confidence,
          intent: draft.intent,
          sentiment: draft.sentiment,
          language: draft.language,
          reasoning: draft.reasoning,
          action: draft.action,
          status: draft.action === 'ignore' ? 'ignored' : draft.action === 'auto_send' ? 'scheduled' : 'pending',
          flaggedFor: JSON.stringify(draft.flaggedFor),
          knowledgeIds: JSON.stringify(draft.knowledge.map((k) => k.id)),
          llmProvider: draft.llmProvider,
          llmModel: draft.llmModel,
          promptTokens: draft.promptTokens,
          outputTokens: draft.outputTokens,
          costUsd: draft.costUsd,
          scheduledFor,
        },
      })

  draft.draftId = record.id
  return draft
}

function mapStatusToAction(status: string, action: string): ReplyDraftResult['action'] {
  if (status === 'ignored') return 'ignore'
  if (status === 'sent') return 'auto_send'
  if (status === 'pending' || status === 'approved' || status === 'scheduled') return action as ReplyDraftResult['action']
  return action as ReplyDraftResult['action']
}

export function inQuietHours(cfg: {
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
}): boolean {
  if (!cfg.quietHoursEnabled) return false
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: cfg.timezone || 'UTC' }))
    const mins = now.getHours() * 60 + now.getMinutes()
    const [sh, sm] = cfg.quietHoursStart.split(':').map(Number)
    const [eh, em] = cfg.quietHoursEnd.split(':').map(Number)
    const start = sh * 60 + (sm || 0)
    const end = eh * 60 + (em || 0)
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
  } catch {
    return false
  }
}

/** Volume guard: how many auto-sends have we already done recently? */
export async function withinVolumeCaps(accountId: string, workspaceId: string, cfg: { maxAutoPerHour: number; maxAutoPerDay: number }) {
  const hourAgo = new Date(Date.now() - 3600_000)
  const dayAgo = new Date(Date.now() - 86_400_000)
  const [perHour, perDay] = await Promise.all([
    prisma.draft.count({ where: { accountId, status: 'sent', sentAt: { gte: hourAgo } } }),
    prisma.draft.count({ where: { accountId, status: 'sent', sentAt: { gte: dayAgo } } }),
  ])
  return {
    ok: perHour < cfg.maxAutoPerHour && perDay < cfg.maxAutoPerDay,
    perHour,
    perDay,
    reason: perHour >= cfg.maxAutoPerHour ? `hourly cap reached (${perHour}/${cfg.maxAutoPerHour})` : perDay >= cfg.maxAutoPerDay ? `daily cap reached (${perDay}/${cfg.maxAutoPerDay})` : null,
    workspaceId,
  }
}

export function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * Math.max(1, max - min)) + min
}

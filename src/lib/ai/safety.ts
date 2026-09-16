

export type SafetyVerdict = {
  blocked: boolean
  escalate: boolean
  reasons: string[]
  /** Guaranteed answer that must be used verbatim (prices, hours, links). */
  guaranteed?: { ruleId: string; response: string }
  competitorMention?: string
}

export interface SafetyInput {
  text: string
  authorName?: string | null
  authorHandle?: string | null
  rules?: {
    id: string
    kind: string
    pattern: string
    matchType: string
    response?: string | null
    enabled: boolean
  }[]
  bannedWords?: string[]
  /** Our own account handles — never reply to ourselves. */
  ownHandles?: string[]
}

const PROFANITY = [
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick',
  'gandu', 'chutiya', 'bc', 'mc', 'harami', 'kutta', 'randi',
]

const ABUSE_PATTERNS = [
  /\b(scam|fraud|cheat(ed|ing)?|thief|stole|steal|fake company|loot)\b/i,
  /\b(report(ed)? you|sue you|lawyer|legal action|court|consumer (court|forum))\b/i,
  /\b(useless|worst (app|product|service|company)|trash|garbage|pathetic|disgusting)\b/i,
  /\b(refund me|money back|chargeback|dispute)\b/i,
]

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/, // phone
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // card
  /\b\d{5}[\s-]?\d{7}[\s-]?\d{3}\b/, // CNIC-like (PK)
  /\border[\s#:_-]*(no\.?|number)?[\s#:_-]*[A-Z0-9-]{6,}\b/i,
]

const SPAM_PATTERNS = [
  /\b(dm me|dm for|check (my|out my) (profile|page)|follow me|follow back|promote)\b/i,
  /\b(crypto|forex|bitcoin|usdt|binance|investment (opportunity|plan)|earn \$?\d)/i,
  /(.)\1{7,}/, // long repeated characters
  /https?:\/\/\S+/i, // links in random comments are usually spam — review, don't auto-send
]

const LOW_EFFORT = [
  /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u,
  /^(hi|hey|hello|yo|ok|okay|nice|cool|good|great|love|wow|lol|lmao|🔥|❤️|👍)\W*$/i,
  /^.{0,2}$/,
]

export function isLowEffort(text: string): boolean {
  const t = (text || '').trim()
  if (t.length === 0) return true
  return LOW_EFFORT.some((re) => re.test(t))
}

function matches(pattern: string, matchType: string, text: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  const lower = text.toLowerCase()
  switch (matchType) {
    case 'exact':
      return lower === p.toLowerCase()
    case 'whole_word': {
      const re = new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i')
      return re.test(text)
    }
    case 'regex':
      try {
        return new RegExp(p, 'i').test(text)
      } catch {
        return false
      }
    default:
      return lower.includes(p.toLowerCase())
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Deterministic safety layer that runs BEFORE and AFTER the model.
 * Before: decides whether we should even attempt a reply, and injects
 * guaranteed answers. After: audits the model output for banned content.
 */
export function evaluateSafety(input: SafetyInput): SafetyVerdict {
  const text = (input.text || '').trim()
  const reasons: string[] = []
  const verdict: SafetyVerdict = { blocked: false, escalate: false, reasons }

  if (!text) {
    verdict.blocked = true
    reasons.push('empty_comment')
    return verdict
  }

  // Never reply to ourselves.
  const handle = (input.authorHandle || '').replace(/^@/, '').toLowerCase()
  if (handle && input.ownHandles?.some((h) => h.replace(/^@/, '').toLowerCase() === handle)) {
    verdict.blocked = true
    reasons.push('own_account_comment')
    return verdict
  }

  const rules = (input.rules ?? []).filter((r) => r.enabled)

  // 1. Hard blocklist
  for (const r of rules.filter((r) => r.kind === 'blocklist')) {
    if (matches(r.pattern, r.matchType, text)) {
      verdict.blocked = true
      reasons.push(`blocklist:${r.pattern}`)
      return verdict
    }
  }

  // 2. Guaranteed answers (prices, hours, links) — bypass the model's freedom
  const guaranteed = rules.find((r) => r.kind === 'guaranteed_answer' && matches(r.pattern, r.matchType, text))
  if (guaranteed?.response) {
    verdict.guaranteed = { ruleId: guaranteed.id, response: guaranteed.response }
  }

  // 3. Escalation keywords → always human review
  for (const r of rules.filter((r) => r.kind === 'escalate_keyword')) {
    if (matches(r.pattern, r.matchType, text)) {
      verdict.escalate = true
      reasons.push(`escalate_keyword:${r.pattern}`)
    }
  }

  // 4. Competitor mentions
  const competitor = rules.find((r) => r.kind === 'competitor' && matches(r.pattern, r.matchType, text))
  if (competitor) {
    verdict.competitorMention = competitor.pattern
    verdict.escalate = true
    reasons.push(`competitor:${competitor.pattern}`)
  }

  // 5. Built-in abuse / complaint detection
  if (ABUSE_PATTERNS.some((re) => re.test(text))) {
    verdict.escalate = true
    reasons.push('abuse_or_complaint_detected')
  }

  // 6. Profanity
  const lower = ` ${text.toLowerCase()} `
  if (PROFANITY.some((w) => lower.includes(` ${w} `)) || PROFANITY.some((w) => new RegExp(`\\b${w}`, 'i').test(text))) {
    verdict.escalate = true
    reasons.push('profanity')
  }

  // 7. PII in the incoming comment — reply publicly is risky
  if (PII_PATTERNS.some((re) => re.test(text))) {
    verdict.escalate = true
    reasons.push('contains_pii')
  }

  // 8. Spam
  if (SPAM_PATTERNS.slice(0, 2).some((re) => re.test(text))) {
    verdict.escalate = true
    reasons.push('possible_spam')
  }

  // 9. Very long comments usually need a human
  if (text.length > 600) {
    verdict.escalate = true
    reasons.push('long_comment')
  }

  return verdict
}

/**
 * Audits the model's draft. Returns reasons the draft must NOT be auto-sent.
 */
export function auditDraft(draft: string, opts: { bannedWords?: string[]; maxChars?: number; platform?: string }): string[] {
  const problems: string[] = []
  const text = (draft || '').trim()
  if (!text) return ['empty_draft']

  const banned = opts.bannedWords ?? []
  for (const w of banned) {
    if (w && new RegExp(`\\b${escapeRegExp(w.trim())}\\b`, 'i').test(text)) {
      problems.push(`banned_word:${w}`)
    }
  }

  if (opts.maxChars && text.length > opts.maxChars) problems.push('too_long')

  // Placeholder / hallucination leaks
  const withoutMarkers = text.replace(/\[MOCK]/gi, '')
  if (/\{[^}]*\}|\[[^\]]*\]|<[^>]*>|\b(lorem ipsum|as an ai|i'?m an ai|language model)\b/i.test(withoutMarkers)) {
    problems.push('contains_placeholder_or_ai_disclosure')
  }
  if (/undefined|NaN|null/i.test(text)) problems.push('contains_debug_value')

  // PII must never leave through an automated reply
  if (PII_PATTERNS.slice(0, 3).some((re) => re.test(text))) problems.push('draft_contains_pii')

  // Platform hard limits
  const limits: Record<string, number> = { x: 280, tiktok: 150, instagram: 2200, facebook_page: 8000, youtube: 10000 }
  const hard = limits[opts.platform ?? '']
  if (hard && text.length > hard) problems.push(`exceeds_${opts.platform}_limit`)

  return problems
}

/** Cheap language hint for the reply-language decision. */
const SCRIPT_HINTS: [RegExp, string][] = [
  // Urdu is written in an extended Arabic script (ٹ ڈ ڑ ں ے ے ہ ی), so it must be
  // tested before the generic Arabic range or every Urdu comment reads as "ar".
  [/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06CC\u06D2\u06D3\u06F0-\u06F9]/, 'ur'],
  [/[\u0600-\u06FF]/, 'ar'],
  [/[\u0900-\u097F]/, 'hi'],
  [/[\u0400-\u04FF]/, 'ru'],
  [/[\u4E00-\u9FFF]/, 'zh'],
  [/[\u3040-\u30FF]/, 'ja'],
  [/[\uAC00-\uD7AF]/, 'ko'],
  [/[\u0E00-\u0E7F]/, 'th'],
  [/[\u0590-\u05FF]/, 'he'],
  [/[\u0E80-\u0EFF]/, 'lo'],
  [/[\u10A0-\u10FF]/, 'ka'],
  [/[\u0530-\u058F]/, 'hy'],
]

const ROMAN_HINTS: [RegExp, string][] = [
  [/\b(kya|nahi|nahin|kaise|shukriya|acha|achha|bhai|bilkul|bohat|bahut|hai|hain|karo|chahiye|kab|kahan|price kitn)\b/i, 'ur'],
  [/\b(qu[eé]|c[oó]mo|gracias|por favor|est[aá]|cu[aá]nto|env[ií]o|cu[aá]ndo)\b/i, 'es'],
  [/\b(ol[aá]|obrigad[oa]|voc[eê]|n[aã]o|quanto|entrega|quando)\b/i, 'pt'],
  [/\b(bonjour|merci|c'est|combien|livraison|quand|o[uù])\b/i, 'fr'],
  [/\b(hallo|danke|wie viel|wann|lieferung)\b/i, 'de'],
  [/\b(ciao|grazie|quanto|quando|spedizione)\b/i, 'it'],
  [/\b(merhaba|teşekkür|ne kadar|kargo)\b/i, 'tr'],
]

export function guessLanguage(text: string): string {
  const t = text || ''
  for (const [re, lang] of SCRIPT_HINTS) if (re.test(t)) return lang
  const letters = t.match(/\p{L}/gu)?.length ?? 0
  if (t.trim() && letters / Math.max(t.trim().length, 1) < 0.4) return 'unknown'
  for (const [re, lang] of ROMAN_HINTS) if (re.test(t)) return lang
  return /[a-z]/i.test(t) ? 'en' : 'unknown'
}

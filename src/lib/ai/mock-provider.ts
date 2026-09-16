import type { ChatMessage, ChatResult } from './llm'

export function mockProviderEnabled(): boolean {
  return process.env.AI_MOCK === '1'
}

/**
 * Deterministic stand-in used when AI_MOCK=1.
 *
 * It reads the prompt ReplyPilot itself built (mandatory answer / safety note /
 * public-vs-DM / customer text) and returns a JSON object shaped exactly like a
 * real model response, so the whole ingest → score → route → send pipeline can
 * be exercised end-to-end without spending tokens.
 *
 * Every reply is prefixed [MOCK] so it can never be mistaken for real output.
 * Turn it off (AI_MOCK=0) the moment a real provider key is configured.
 */
export function mockChat(messages: ChatMessage[], json: boolean): ChatResult {
  const prompt = messages.map((m) => m.content).join('\n')
  const hasMandatory = /MANDATORY ANSWER/.test(prompt)
  const hasSafetyNote = /INTERNAL NOTE: this message was flagged/.test(prompt)
  const isPublic = /This is a PUBLIC comment/.test(prompt)

  // The prompt puts the customer's message on its own line right after the
  // `CUSTOMER (name @handle):` header, so extract it literally rather than with
  // a regex that could also match the conversation-history block.
  // The prompt puts the customer's message right after the
  // `CUSTOMER (name @handle):` header, but a blank line can follow the header,
  // so take the next non-empty line rather than assuming it is the next one.
  const lines = prompt.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('CUSTOMER ('))
  const customer =
    headerIdx >= 0 ? (lines.slice(headerIdx + 1).find((l) => l.trim() && !l.startsWith('This is a ')) ?? '').trim() : ''
  const firstLine = customer

  let reply = ''
  let confidence = 0.5
  let intent = 'question'
  let needsHuman = false
  let shouldIgnore = false
  let reasoning = ''

  if (/\b(spam|dm me for|check my profile|crypto|forex|follow back)\b/i.test(customer)) {
    reply = ''
    confidence = 0.05
    intent = 'spam'
    shouldIgnore = true
    reasoning = 'Mock provider (AI_MOCK=1): looks like spam, so no reply.'
  } else if (hasMandatory) {
    reply = `[MOCK] ${firstLine ? firstLine.slice(0, 60) : 'Thanks for asking'} — flat Rs 250 nationwide, free above Rs 5,000.`
    confidence = 0.93
    intent = 'question'
    reasoning = 'Mock provider (AI_MOCK=1): a guaranteed-answer rule matched, so this is fully grounded.'
  } else if (hasSafetyNote) {
    reply = '[MOCK] I am sorry about the trouble — please DM your order number and our team will sort this out today.'
    confidence = 0.32
    intent = 'complaint'
    needsHuman = true
    reasoning = 'Mock provider (AI_MOCK=1): the safety layer flagged this, so it is routed to a human.'
  } else if (/[?\u061F\uFF1F]/.test(customer)) {
    reply = isPublic
      ? '[MOCK] Good question — I have sent you the details in a DM so nothing personal is posted publicly.'
      : '[MOCK] Happy to help with that. Could you share a little more detail so I can point you to the right answer?'
    confidence = 0.68
    intent = isPublic ? 'purchase_intent' : 'support_issue'
    reasoning = 'Mock provider (AI_MOCK=1): no exact knowledge match, so confidence sits in the review band.'
  } else {
    reply = '[MOCK] Thanks so much for the love — it genuinely makes our day. 🙌'
    confidence = 0.86
    intent = 'praise'
    reasoning = 'Mock provider (AI_MOCK=1): conversational message with no question, safe to auto-send.'
  }

  const payload = {
    reply,
    alternates: reply ? [`[MOCK] alternate: ${reply.replace('[MOCK] ', '').slice(0, 140)}`] : [],
    confidence,
    intent,
    sentiment: intent === 'complaint' ? 'negative' : intent === 'praise' ? 'positive' : 'neutral',
    language: /[\u0600-\u06FF\u0900-\u097F]/.test(customer) ? 'ur' : 'en',
    reasoning,
    needs_human: needsHuman,
    should_ignore: shouldIgnore,
    used_knowledge: hasMandatory,
  }

  return {
    data: json ? payload : JSON.stringify(payload),
    raw: JSON.stringify(payload),
    provider: 'mock',
    model: 'replypilot-mock-1',
    usage: {
      promptTokens: Math.round(prompt.length / 4),
      outputTokens: Math.round(JSON.stringify(payload).length / 4),
      costUsd: 0,
    },
    latencyMs: 1,
  }
}

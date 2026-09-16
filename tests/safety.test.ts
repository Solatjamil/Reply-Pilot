import test from 'node:test'
import assert from 'node:assert/strict'
import { auditDraft, evaluateSafety, guessLanguage, isLowEffort } from '../src/lib/ai/safety'

const rules = [
  { id: 'r1', kind: 'guaranteed_answer', pattern: 'shipping', matchType: 'contains', response: 'Flat Rs 250 nationwide, free above Rs 5,000.', enabled: true },
  { id: 'r2', kind: 'escalate_keyword', pattern: 'refund', matchType: 'whole_word', response: null, enabled: true },
  { id: 'r3', kind: 'blocklist', pattern: 'dm me for', matchType: 'contains', response: null, enabled: true },
  { id: 'r4', kind: 'competitor', pattern: 'nike', matchType: 'whole_word', response: null, enabled: true },
  { id: 'r5', kind: 'blocklist', pattern: '^buy now$', matchType: 'regex', response: null, enabled: true },
  { id: 'r6', kind: 'escalate_keyword', pattern: 'broken', matchType: 'exact', response: null, enabled: false },
]

test('guaranteed answer is surfaced and does not escalate', () => {
  const v = evaluateSafety({ text: 'How much is shipping to Lahore?', rules })
  assert.equal(v.blocked, false)
  assert.equal(v.escalate, false)
  assert.equal(v.guaranteed?.ruleId, 'r1')
  assert.match(v.guaranteed!.response, /Rs 250/)
})

test('escalate keyword routes to a human', () => {
  const v = evaluateSafety({ text: 'I want a refund now', rules })
  assert.equal(v.escalate, true)
  assert.ok(v.reasons.some((r) => r.includes('escalate_keyword')))
})

test('blocklist blocks outright', () => {
  const v = evaluateSafety({ text: 'dm me for cheap followers', rules })
  assert.equal(v.blocked, true)
})

test('matchType whole_word does not fire inside another word', () => {
  // "refunds" contains "refund" but is not the whole word
  assert.equal(evaluateSafety({ text: 'refunds are processed weekly', rules }).reasons.some((r) => r.includes('escalate_keyword')), false)
  assert.equal(evaluateSafety({ text: 'refund', rules }).escalate, true)
})

test('matchType exact only fires on an exact match', () => {
  const enabled = rules.map((r) => (r.id === 'r6' ? { ...r, enabled: true } : r))
  assert.equal(evaluateSafety({ text: 'broken', rules: enabled }).escalate, true)
  assert.equal(evaluateSafety({ text: 'my screen is broken', rules: enabled }).reasons.some((r) => r.includes('broken')), false)
})

test('matchType regex is anchored as written', () => {
  assert.equal(evaluateSafety({ text: 'buy now', rules }).blocked, true)
  assert.equal(evaluateSafety({ text: 'please buy now everyone', rules }).blocked, false)
})

test('disabled rules are ignored', () => {
  assert.equal(evaluateSafety({ text: 'broken', rules }).escalate, false)
})

test('competitor mentions escalate with the competitor named', () => {
  const v = evaluateSafety({ text: 'Nike is better than you guys', rules })
  assert.equal(v.escalate, true)
  assert.equal(v.competitorMention?.toLowerCase(), 'nike')
})

test('abuse and legal threats escalate even with no custom rules', () => {
  for (const text of ['This is a scam', 'I will sue you', 'worst app ever, total trash', 'I want my money back']) {
    assert.equal(evaluateSafety({ text, rules: [] }).escalate, true, `expected escalation for: ${text}`)
  }
})

test('personal data escalates rather than being repeated publicly', () => {
  const v = evaluateSafety({ text: 'my card is 4111 1111 1111 1111 and my email is a@b.com', rules: [] })
  assert.equal(v.escalate, true)
  assert.ok(v.reasons.includes('contains_pii'))
})

test('we never reply to our own account', () => {
  const v = evaluateSafety({ text: 'thanks everyone', authorHandle: '@demobrand', rules: [], ownHandles: ['demobrand'] })
  assert.equal(v.blocked, true)
  assert.ok(v.reasons.includes('own_account_comment'))
})

test('profanity escalates', () => {
  assert.equal(evaluateSafety({ text: 'you guys are useless idiots', rules: [] }).escalate, true)
})

test('low-effort detection', () => {
  assert.equal(isLowEffort('🔥🔥🔥'), true)
  assert.equal(isLowEffort('nice'), true)
  assert.equal(isLowEffort('How much is shipping to Lahore?'), false)
})

test('draft audit catches placeholders, AI disclosure, banned words and length', () => {
  assert.ok(auditDraft('Hi {name}!', {}).includes('contains_placeholder_or_ai_disclosure'))
  assert.ok(auditDraft("As an AI, I can't help.", {}).includes('contains_placeholder_or_ai_disclosure'))
  assert.deepEqual(auditDraft('We guarantee the cheapest price!', { bannedWords: ['guarantee', 'cheapest'] }), [
    'banned_word:guarantee',
    'banned_word:cheapest',
  ])
  assert.ok(auditDraft('a'.repeat(300), { platform: 'x' }).includes('exceeds_x_limit'))
  assert.deepEqual(auditDraft('Flat Rs 250, free above Rs 5,000 🙌', { bannedWords: ['guarantee'], maxChars: 300, platform: 'instagram' }), [])
})

test('the [MOCK] marker is not mistaken for a leaked placeholder', () => {
  assert.deepEqual(auditDraft('[MOCK] Thanks for asking!', {}), [])
  // …but a genuine placeholder inside a mock reply is still caught
  assert.ok(auditDraft('[MOCK] Hi {name}', {}).includes('contains_placeholder_or_ai_disclosure'))
})

test('language detection covers the scripts and romanised forms we care about', () => {
  const cases: [string, string][] = [
    // Urdu uses an extended Arabic script and must not be reported as Arabic.
    ['کیا آپ کراچی میں ڈیلیوری کرتے ہیں؟ شکریہ', 'ur'],
    ['شکریہ بھائی', 'ur'],
    ['مرحبا كم السعر', 'ar'],
    ['आप कब डिलीवर करोगे?', 'hi'],
    ['how much is shipping?', 'en'],
    ['¿cuánto cuesta el envío?', 'es'],
    ['você entrega em Lisboa?', 'pt'],
    ['combien coûte la livraison?', 'fr'],
    ['wie viel kostet der Versand?', 'de'],
    ['ne kadar kargo?', 'tr'],
    ['こんにちは', 'ja'],
    ['안녕하세요', 'ko'],
    ['привет сколько стоит', 'ru'],
    ['ขอบคุณครับ', 'th'],
    ['שלום', 'he'],
    ['Გამარჯობა', 'ka'],
    ['kya price hai bhai', 'ur'], // romanised Urdu
    ['🔥🔥🔥', 'unknown'],
  ]
  for (const [text, expected] of cases) {
    assert.equal(guessLanguage(text), expected, `expected ${expected} for: ${text}`)
  }
})

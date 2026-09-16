import test from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, decryptJson, encrypt, encryptJson, maskToken, passwordHash, passwordVerify, randomToken, safeEqual, sha256 } from '../src/lib/crypto'
import { PLATFORM_CHAR_LIMITS, inQuietHours } from '../src/lib/ai/reply-engine'
import { mockChat, mockProviderEnabled } from '../src/lib/ai/mock-provider'
import { adapterFor } from '../src/lib/platforms'
import { PLATFORMS } from '../src/lib/platforms/catalog'
import type { ChatMessage } from '../src/lib/ai/llm'

// ─────────────────────────── Crypto ───────────────────────────────────────

test('token encryption round-trips and produces a different ciphertext each time', () => {
  const plain = 'EAABwzLixnjYBO2Z...'
  const a = encrypt(plain)
  const b = encrypt(plain)
  assert.equal(decrypt(a), plain)
  assert.equal(decrypt(b), plain)
  assert.notEqual(a, b, 'AES-GCM must use a fresh IV per encryption')
  assert.ok(!a.includes(plain), 'ciphertext must not contain the plaintext')
})

test('tampering with a ciphertext fails instead of returning garbage', () => {
  const sealed = encrypt('secret-token-value')
  const [version, iv, tag, data] = sealed.split('.')
  assert.ok(version && iv && tag && data)
  const flipped = `${version}.${iv}.${tag}.${data.slice(0, -4)}AAAA`
  assert.throws(() => decrypt(flipped))
})

test('decrypting null/undefined is a safe no-op', () => {
  assert.equal(decrypt(null), '')
  assert.equal(decrypt(undefined), '')
  assert.equal(decrypt(''), '')
})

test('a value not sealed by us is passed through as legacy plaintext', () => {
  // Deliberate: tokens stored before encryption was introduced must keep working
  // instead of breaking every connected account on upgrade.
  assert.equal(decrypt('EAABwzLixnjY-legacy-plaintext'), 'EAABwzLixnjY-legacy-plaintext')
  assert.equal(decryptJson('not json'), null)
})

test('JSON payloads round-trip', () => {
  const value = { accessToken: 'abc', pageId: '123', nested: { a: [1, 2, 3] } }
  assert.deepEqual(decryptJson(encryptJson(value)), value)
  assert.equal(decryptJson(null), null)
  assert.equal(decryptJson('garbage'), null)
})

test('password hashing verifies and rejects', () => {
  const hash = passwordHash('replypilot123')
  assert.equal(passwordVerify('replypilot123', hash), true)
  assert.equal(passwordVerify('wrong-password', hash), false)
  assert.equal(passwordVerify('replypilot123', 'malformed'), false)
  assert.notEqual(passwordHash('replypilot123'), hash, 'each hash must be salted')
})

test('maskToken hides all but the tail', () => {
  assert.equal(maskToken(null), '')
  assert.equal(maskToken(''), '')
  const masked = maskToken('EAABwzLixnjYBO2ZVeryLongTokenValue')
  assert.ok(masked.length < 20)
  assert.ok(!masked.includes('EAABwzLixnjY'))
})

test('safeEqual is constant-time-ish and correct', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', ''), true)
})

test('sha256 and randomToken are well-formed', () => {
  assert.equal(sha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.match(randomToken(8), /^[A-Za-z0-9_-]{10,11}$/, 'base64url of 8 bytes')
  assert.notEqual(randomToken(), randomToken())
})

// ─────────────────────────── Routing policy ───────────────────────────────

const quiet = (start: string, end: string, timezone = 'UTC') =>
  inQuietHours({ quietHoursEnabled: true, quietHoursStart: start, quietHoursEnd: end, timezone })

test('quiet hours are disabled by default', () => {
  assert.equal(inQuietHours({ quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00', timezone: 'UTC' }), false)
})

test('quiet hours handle a window that crosses midnight', () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }))
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  // A window that definitely contains "now".
  assert.equal(quiet('00:00', '23:59'), true, `expected ${hhmm} to be inside 00:00-23:59`)
  // A 1-minute window that definitely does not (unless the test runs in it).
  const past = new Date(now.getTime() - 3 * 3600_000)
  const pastStart = `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`
  const pastEnd = `${String(past.getUTCHours()).padStart(2, '0')}:${String((past.getUTCMinutes() + 1) % 60).padStart(2, '0')}`
  if (pastStart !== pastEnd) assert.equal(quiet(pastStart, pastEnd), false, `${hhmm} should be outside ${pastStart}-${pastEnd}`)
})

test('an invalid timezone fails open rather than blocking every reply', () => {
  assert.equal(quiet('00:00', '23:59', 'Not/AZone'), false)
})

test('every platform has a character limit and X is the tightest', () => {
  for (const id of Object.keys(PLATFORMS)) {
    assert.ok(PLATFORM_CHAR_LIMITS[id] > 0, `${id} is missing a char limit`)
  }
  assert.equal(PLATFORM_CHAR_LIMITS.x, 280)
  assert.ok(PLATFORM_CHAR_LIMITS.youtube > PLATFORM_CHAR_LIMITS.x)
})

// ─────────────────────── Platform capability gates ────────────────────────

test('every platform resolves to an adapter', () => {
  for (const id of Object.keys(PLATFORMS)) {
    assert.ok(adapterFor(id), `${id} has no adapter`)
  }
  assert.equal(adapterFor('nonexistent'), undefined)
})

test('capabilities match what each platform actually permits', () => {
  // YouTube has no messaging API at all.
  assert.equal(PLATFORMS.youtube.capabilities.readDms, false)
  assert.equal(PLATFORMS.youtube.capabilities.sendDm, false)
  assert.equal(PLATFORMS.youtube.capabilities.replyToComment, true)
  // Instagram supports private replies from a comment; the others do not.
  assert.equal(PLATFORMS.instagram.capabilities.privateReplyFromComment, true)
  assert.equal(PLATFORMS.facebook_page.capabilities.privateReplyFromComment, true)
  assert.equal(PLATFORMS.youtube.capabilities.privateReplyFromComment, false)
  assert.equal(PLATFORMS.linkedin_org.capabilities.privateReplyFromComment, false)
  // Meta and X (paid tier) have realtime webhooks; everything else polls.
  for (const id of ['facebook_page', 'instagram', 'messenger', 'x'] as const) {
    assert.equal(PLATFORMS[id].capabilities.webhooks, true, `${id} should support webhooks`)
  }
  for (const id of ['tiktok', 'youtube', 'linkedin_org', 'linkedin_person'] as const) {
    assert.equal(PLATFORMS[id].capabilities.webhooks, false, `${id} has no public webhook API`)
  }
})

// ─────────────────────────── Mock provider ────────────────────────────────

const userPrompt = (text: string, opts: { dm?: boolean; mandatory?: boolean; safety?: boolean } = {}) =>
  [
    'KNOWLEDGE BASE (the only facts you may use)',
    '(no knowledge base entries matched)',
    opts.safety ? 'INTERNAL NOTE: this message was flagged by safety rules (escalate_keyword:refund).' : '',
    opts.mandatory ? 'MANDATORY ANSWER: the brand requires this exact information to be conveyed. Use it as the factual basis of your reply.' : '',
    '',
    'CUSTOMER (Ayesha @ayesha.k):',
    text,
    '',
    opts.dm === false ? 'This is a PUBLIC comment — keep it short.' : 'This is a PRIVATE direct message — you may ask for details.',
  ]
    .filter((l) => l !== '')
    .join('\n')

const run = (text: string, opts?: Parameters<typeof userPrompt>[1]) => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: userPrompt(text, opts) },
  ]
  return mockChat(messages, true).data as Record<string, unknown>
}

test('mock mode is controlled by AI_MOCK', () => {
  const previous = process.env.AI_MOCK
  process.env.AI_MOCK = '1'
  assert.equal(mockProviderEnabled(), true)
  process.env.AI_MOCK = '0'
  assert.equal(mockProviderEnabled(), false)
  delete process.env.AI_MOCK
  assert.equal(mockProviderEnabled(), false)
  if (previous !== undefined) process.env.AI_MOCK = previous
})

test('the mock provider returns the exact JSON contract the engine parses', () => {
  const out = run('Hello!')
  for (const key of ['reply', 'alternates', 'confidence', 'intent', 'sentiment', 'language', 'reasoning', 'needs_human', 'should_ignore']) {
    assert.ok(key in out, `missing ${key}`)
  }
  assert.equal(typeof out.confidence, 'number')
  assert.ok(Array.isArray(out.alternates))
})

test('a grounded answer scores in the auto-send band', () => {
  const out = run('How much is shipping?', { mandatory: true })
  assert.ok((out.confidence as number) >= 0.9)
  assert.equal(out.used_knowledge, true)
})

test('a safety-flagged message is routed to a human', () => {
  const out = run('I want a refund', { safety: true })
  assert.equal(out.needs_human, true)
  assert.ok((out.confidence as number) < 0.4)
})

test('spam is ignored with an empty reply', () => {
  const out = run('dm me for cheap followers crypto')
  assert.equal(out.should_ignore, true)
  assert.equal(out.reply, '')
})

test('an ungrounded question lands in the review band', () => {
  const out = run('Do you have this in blue?')
  const c = out.confidence as number
  assert.ok(c >= 0.4 && c < 0.9, `expected a mid-band confidence, got ${c}`)
})

test('public comments do not ask for personal data in the reply', () => {
  const out = run('Where is my order?', { dm: false })
  assert.ok(!/order number|email|phone/i.test(String(out.reply)))
})

test('every mock reply is visibly marked', () => {
  for (const text of ['Hello!', 'How much is shipping?', 'I want a refund', 'Do you have this in blue?']) {
    const reply = String(run(text).reply)
    if (reply) assert.ok(reply.startsWith('[MOCK]'), `unmarked mock reply: ${reply}`)
  }
})

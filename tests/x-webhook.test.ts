import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { xAdapter } from '../src/lib/platforms/adapters/x'

const body = '{"for_user_id":"123","tweet_create_events":[]}'
const secret = 'x-consumer-secret-for-tests-32chars'

const sign = (raw: string) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('base64')}`

const post = (signature: string | null) =>
  xAdapter.verifyWebhook!({
    method: 'POST',
    query: {},
    rawBody: body,
    headers: new Headers(signature ? { 'x-twitter-webhooks-signature': signature } : {}),
  })

test('CRC handshake returns the base64 HMAC of crc_token', () => {
  const previous = process.env.X_API_KEY_SECRET
  process.env.X_API_KEY_SECRET = secret
  try {
    const res = xAdapter.verifyWebhook!({ method: 'GET', query: { crc_token: 'abc123' }, rawBody: '', headers: new Headers() })
    assert.equal(res.ok, true)
    const expected = `sha256=${crypto.createHmac('sha256', secret).update('abc123').digest('base64')}`
    assert.deepEqual(JSON.parse(res.challenge!), { response_token: expected })
  } finally {
    if (previous === undefined) delete process.env.X_API_KEY_SECRET
    else process.env.X_API_KEY_SECRET = previous
  }
})

test('CRC handshake fails loudly without a consumer secret', () => {
  delete process.env.X_API_KEY_SECRET
  const res = xAdapter.verifyWebhook!({ method: 'GET', query: { crc_token: 'abc123' }, rawBody: '', headers: new Headers() })
  assert.equal(res.ok, false)
  assert.match(res.message!, /X_API_KEY_SECRET/)
})

test('a correctly signed webhook POST is accepted', () => {
  const previous = process.env.X_API_KEY_SECRET
  process.env.X_API_KEY_SECRET = secret
  try {
    assert.equal(post(sign(body)).ok, true)
  } finally {
    if (previous === undefined) delete process.env.X_API_KEY_SECRET
    else process.env.X_API_KEY_SECRET = previous
  }
})

test('a tampered body or missing signature is rejected when a secret is set', () => {
  const previous = process.env.X_API_KEY_SECRET
  process.env.X_API_KEY_SECRET = secret
  try {
    assert.equal(post(sign('{"for_user_id":"999"}')).ok, false, 'signature for a different body must not validate')
    const missing = post(null)
    assert.equal(missing.ok, false)
    assert.equal(missing.status, 401)
  } finally {
    if (previous === undefined) delete process.env.X_API_KEY_SECRET
    else process.env.X_API_KEY_SECRET = previous
  }
})

test('an unverifiable signature is refused rather than trusted', () => {
  delete process.env.X_API_KEY_SECRET
  const res = post(sign(body))
  assert.equal(res.ok, false)
  assert.equal(res.status, 500)
  assert.match(res.message!, /X_API_KEY_SECRET/)
})

test('unsigned local development traffic still passes, with a warning', () => {
  delete process.env.X_API_KEY_SECRET
  assert.equal(post(null).ok, true)
})

test('X Account Activity payloads are parsed into comment/DM events', () => {
  const parse = (payload: unknown) => xAdapter.parseWebhook!(JSON.stringify(payload), new Headers())

  const dm = parse({
    for_user_id: '12345',
    direct_message_events: [
      {
        id: 'dm_1',
        created_timestamp: '1757500000000',
        type: 'message_create',
        message_create: {
          sender_id: '999',
          target: { recipient_id: '12345' },
          message_data: { text: 'Do you ship to Karachi?' },
        },
      },
    ],
  })
  assert.equal(dm.length, 1)
  assert.equal(dm[0].type, 'message')
  assert.equal(dm[0].accountUid, '12345')
  assert.equal(dm[0].message?.direction, 'inbound')
  assert.equal(dm[0].message?.text, 'Do you ship to Karachi?')

  const mention = parse({
    for_user_id: '12345',
    tweet_create_events: [
      {
        id_str: 't_1',
        text: '@demobrand is this in stock?',
        created_at: 'Wed Sep 10 10:26:41 +0000 2025',
        in_reply_to_status_id_str: null,
        user: { id_str: '999', screen_name: 'someone', name: 'Someone' },
      },
    ],
  })
  assert.ok(mention.length >= 1)
  assert.equal(mention[0].platform, 'x')

  assert.deepEqual(parse('not json'), [])
  assert.deepEqual(parse({ for_user_id: '12345' }), [])
})

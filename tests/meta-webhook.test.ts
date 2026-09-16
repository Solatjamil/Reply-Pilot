import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { metaAdapter } from '../src/lib/platforms/adapters/meta'

const parse = (payload: unknown) => metaAdapter.parseWebhook!(JSON.stringify(payload), new Headers())

test('Instagram comment webhook resolves to the IG account uid', () => {
  const events = parse({
    object: 'instagram',
    entry: [
      {
        id: '17841400000000000',
        instagram_user_id: '17841400000000000',
        time: 1757500000,
        changes: [
          {
            field: 'comments',
            value: {
              id: '17890000000001',
              text: 'Is this available in blue?',
              timestamp: 1757500000000,
              from: { id: 'u1', username: 'fatima.x' },
              media: { id: 'media_99' },
            },
          },
        ],
      },
    ],
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].platform, 'instagram')
  assert.equal(events[0].type, 'comment')
  assert.equal(events[0].accountUid, '17841400000000000')
  assert.equal(events[0].comment?.platformUid, '17890000000001')
  assert.equal(events[0].comment?.contentUid, 'media_99')
  assert.equal(events[0].comment?.authorHandle, 'fatima.x')
  assert.equal(events[0].comment?.text, 'Is this available in blue?')
})

test('Facebook Page feed comment webhook uses the Page id', () => {
  const events = parse({
    object: 'page',
    entry: [
      {
        id: 'PAGE_1',
        time: 1757500000,
        changes: [
          {
            field: 'feed',
            value: {
              verb: 'add',
              item: 'comment',
              comment_id: 'POST_1_2',
              post_id: 'POST_1',
              message: 'Do you deliver to Multan?',
              from: { id: 'u2', name: 'Ali' },
              created_time: 1757500000,
            },
          },
        ],
      },
    ],
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].platform, 'facebook_page')
  assert.equal(events[0].accountUid, 'PAGE_1')
  assert.equal(events[0].comment?.platformUid, 'POST_1_2')
  assert.equal(events[0].comment?.authorName, 'Ali')
})

test('Messenger DM webhook carries BOTH a thread and a message', () => {
  // Regression: applyWebhookEvents used to treat these as alternatives, so
  // every DM webhook was stored as a thread and the message was dropped.
  const events = parse({
    object: 'page',
    entry: [
      {
        id: 'PAGE_1',
        time: 1757500000,
        messaging: [
          {
            sender: { id: 'user_8001' },
            recipient: { id: 'PAGE_1' },
            timestamp: 1757500000000,
            message: { mid: 'm_1', text: 'Hi, do you deliver to Karachi?' },
          },
        ],
      },
    ],
  })

  assert.equal(events.length, 1)
  assert.ok(events[0].thread, 'thread must be present')
  assert.ok(events[0].message, 'message must be present alongside the thread')
  assert.equal(events[0].message?.platformUid, 'm_1')
  assert.equal(events[0].message?.direction, 'inbound')
  assert.equal(events[0].message?.text, 'Hi, do you deliver to Karachi?')
  assert.equal(events[0].thread?.participantId, 'user_8001')
  assert.equal(events[0].platform, 'messenger')
  assert.equal(events[0].accountUid, 'PAGE_1')
})

test('Instagram DM webhook is attributed to the IG account, not the Page', () => {
  const events = parse({
    object: 'instagram',
    entry: [
      {
        id: 'PAGE_1',
        instagram_user_id: 'IG_77',
        time: 1757500000,
        messaging: [
          {
            sender: { id: 'user_9' },
            recipient: { id: 'IG_77' },
            timestamp: 1757500000000,
            message: { mid: 'm_ig', text: 'price please' },
          },
        ],
      },
    ],
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].platform, 'instagram')
  assert.equal(events[0].accountUid, 'IG_77')
})

test('echoes (our own outbound messages) never produce an inbound event', () => {
  const events = parse({
    object: 'page',
    entry: [
      {
        id: 'PAGE_1',
        time: 1757500000,
        messaging: [
          {
            sender: { id: 'PAGE_1' },
            recipient: { id: 'user_1' },
            timestamp: 1757500000000,
            message: { mid: 'm_echo', text: 'Thanks!', is_echo: true },
          },
        ],
      },
    ],
  })

  const inbound = events.filter((e) => e.message?.direction === 'inbound')
  assert.equal(inbound.length, 0)
})

test('empty and malformed payloads are ignored, not thrown', () => {
  assert.deepEqual(parse({}), [])
  assert.deepEqual(parse({ object: 'page', entry: [] }), [])
  assert.deepEqual(metaAdapter.parseWebhook!('not json at all', new Headers()), [])
  assert.deepEqual(parse({ object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'u' }, message: { mid: 'x', text: '' } }] }] }), [])
})

test('webhook signature verification rejects tampering', () => {
  const body = '{"object":"page","entry":[]}'
  const secret = 'test-secret-value-32-chars-long!!'
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  // env.meta.appSecret is a live getter over process.env, so setting it here
  // is enough — no adapter re-instantiation needed.
  const verify = (signature: string | null) =>
    metaAdapter.verifyWebhook!({
      method: 'POST',
      query: {},
      rawBody: body,
      headers: new Headers(signature ? { 'x-hub-signature-256': signature } : {}),
    })

  const previous = process.env.META_APP_SECRET
  process.env.META_APP_SECRET = secret
  try {
    assert.equal(verify(good).ok, true, 'a correct signature is accepted')
    assert.equal(verify('sha256=deadbeef').ok, false, 'a tampered body is rejected')
    assert.equal(verify(null).ok, false, 'a configured secret must require a signature')
  } finally {
    if (previous === undefined) delete process.env.META_APP_SECRET
    else process.env.META_APP_SECRET = previous
  }

  // With no secret configured, an unverifiable signature must be refused
  // rather than silently trusted.
  delete process.env.META_APP_SECRET
  const unsigned = metaAdapter.verifyWebhook!({ method: 'POST', query: {}, rawBody: body, headers: new Headers() })
  assert.equal(unsigned.ok, true, 'unsigned dev requests are still accepted (with a warning)')
  const unverifiable = metaAdapter.verifyWebhook!({
    method: 'POST',
    query: {},
    rawBody: body,
    headers: new Headers({ 'x-hub-signature-256': good }),
  })
  assert.equal(unverifiable.ok, false, 'a signature we cannot verify must not be trusted')
})

test('the GET verification handshake echoes hub.challenge only for our token', () => {
  const previous = process.env.META_VERIFY_TOKEN
  process.env.META_VERIFY_TOKEN = 'expected-token'
  try {
    const okRes = metaAdapter.verifyWebhook!({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'expected-token', 'hub.challenge': 'CHALLENGE_123' },
      rawBody: '',
      headers: new Headers(),
    })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.challenge, 'CHALLENGE_123')

    const bad = metaAdapter.verifyWebhook!({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'WRONG', 'hub.challenge': 'X' },
      rawBody: '',
      headers: new Headers(),
    })
    assert.equal(bad.ok, false)
  } finally {
    if (previous === undefined) delete process.env.META_VERIFY_TOKEN
    else process.env.META_VERIFY_TOKEN = previous
  }
})

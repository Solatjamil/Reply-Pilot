import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { assertDatabaseConfig } from '../src/lib/env'

// Regression guard for the "table `main.User` does not exist" incident: on
// Vercel an unset DATABASE_URL used to fall back to file:./dev.db, i.e. an
// empty ephemeral SQLite file, and every query 500-ed with a SQLite schema
// name ("main") in the message. assertDatabaseConfig() must turn that
// misconfiguration into a loud, actionable boot error instead.

const saved = { VERCEL: process.env.VERCEL, DATABASE_URL: process.env.DATABASE_URL, AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME }

after(() => {
  // node:test runs these sequentially in one process; restore afterwards so
  // other test files never observe a fake Vercel environment.
  process.env.VERCEL = saved.VERCEL
  process.env.DATABASE_URL = saved.DATABASE_URL
  process.env.AWS_LAMBDA_FUNCTION_NAME = saved.AWS_LAMBDA_FUNCTION_NAME
})

test('serverless + sqlite file URL throws an actionable config error', () => {
  process.env.VERCEL = '1'
  process.env.DATABASE_URL = 'file:./dev.db'
  assert.throws(() => assertDatabaseConfig(), /DATABASE_URL must be a postgresql:\/\/ connection string/)
  assert.throws(() => assertDatabaseConfig(), /docs\/DEPLOYING\.md/, 'error must point at the deploy guide')
})

test('serverless + unset DATABASE_URL throws', () => {
  process.env.VERCEL = '1'
  delete process.env.DATABASE_URL
  assert.throws(() => assertDatabaseConfig(), /not set at all/)
})

test('serverless + postgres URL boots quietly', () => {
  process.env.VERCEL = '1'
  for (const url of ['postgresql://u:p@db.example.com:5432/rp?sslmode=require', 'postgres://u:p@db.example.com/rp']) {
    process.env.DATABASE_URL = url
    assert.doesNotThrow(() => assertDatabaseConfig(), `should accept ${url.split(':')[0]}`)
  }
})

test('local dev keeps the zero-setup sqlite default', () => {
  delete process.env.VERCEL
  delete process.env.AWS_LAMBDA_FUNCTION_NAME
  process.env.DATABASE_URL = 'file:./dev.db'
  assert.doesNotThrow(() => assertDatabaseConfig())
  delete process.env.DATABASE_URL
  assert.doesNotThrow(() => assertDatabaseConfig(), 'unset must also be fine off serverless')
})

test('error message never leaks connection credentials', () => {
  process.env.VERCEL = '1'
  process.env.DATABASE_URL = 'mysql://alice:sup3rs3cret@db.example.com/rp'
  let msg = ''
  try {
    assertDatabaseConfig()
  } catch (e) {
    msg = (e as Error).message
  }
  assert.ok(msg, 'expected a throw')
  assert.ok(!msg.includes('sup3rs3cret'), 'password must be masked')
  assert.ok(!msg.includes('alice'), 'username must be masked')
})

/**
 * Seeds the workspace, the bootstrap admin, a usable default brand voice,
 * starter safety rules, and (optionally) demo data so the UI is explorable
 * before any platform is connected.
 *
 *   npm run db:seed               normal seed (idempotent)
 *   npm run db:seed               bootstrap admin + demo profile + inbox items
 *   SEED_DEMO=0 npm run db:seed   skip the demo profile (clean production seed)
 */
import crypto from 'node:crypto'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaPg } from '@prisma/adapter-pg'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// .env is not auto-loaded by tsx — do it explicitly.
const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

const DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db'
const isPostgres = /^postgres(ql)?:\/\//.test(DATABASE_URL)

const adapter = isPostgres
  ? new PrismaPg({ connectionString: DATABASE_URL })
  : new PrismaBetterSqlite3({ url: DATABASE_URL.replace(/^file:/, '') })

const prisma = new PrismaClient({ adapter })

function passwordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

const KNOWLEDGE = [
  {
    kind: 'policy',
    title: 'Shipping cost & times',
    question: 'How much is shipping and how long does it take?',
    body: 'EDIT ME — example: Flat Rs 250 nationwide via TCS, free on orders above Rs 5,000. Karachi 1-2 working days, other cities 2-4 working days. Orders placed before 3pm PKT ship the same day.',
    tags: ['shipping', 'delivery', 'courier'],
  },
  {
    kind: 'policy',
    title: 'Returns & refunds',
    question: 'What is your return policy?',
    body: 'EDIT ME — example: 7-day return window for unused items in original packaging. Refunds are processed to the original payment method within 5 working days of the item reaching our warehouse. DM us your order number to start a return.',
    tags: ['returns', 'refund', 'exchange'],
  },
  {
    kind: 'faq',
    title: 'How to order / payment methods',
    question: 'How do I place an order and what payment methods do you accept?',
    body: 'EDIT ME — example: Order through the link in our bio. We accept bank transfer, EasyPaisa, JazzCash and cash on delivery within Pakistan.',
    tags: ['order', 'payment', 'cod'],
  },
  {
    kind: 'faq',
    title: 'Business hours & response time',
    question: 'When are you open / when will someone reply?',
    body: 'EDIT ME — example: Monday to Saturday, 10am to 7pm PKT. Comments and DMs get a reply within a few minutes during those hours.',
    tags: ['hours', 'timing', 'contact'],
  },
]

const SAFETY_RULES = [
  { kind: 'escalate_keyword', pattern: 'refund', matchType: 'whole_word', response: null },
  { kind: 'escalate_keyword', pattern: 'order status', matchType: 'contains', response: null },
  { kind: 'escalate_keyword', pattern: 'complaint', matchType: 'contains', response: null },
  { kind: 'escalate_keyword', pattern: 'lawyer', matchType: 'contains', response: null },
  { kind: 'blocklist', pattern: 'dm me for', matchType: 'contains', response: null },
  { kind: 'blocklist', pattern: 'check my profile', matchType: 'contains', response: null },
  { kind: 'competitor', pattern: 'your competitor', matchType: 'contains', response: null },
]

async function main() {
  const email = (process.env.BOOTSTRAP_EMAIL || 'admin@replypilot.local').toLowerCase()
  const password = process.env.BOOTSTRAP_PASSWORD || 'replypilot123'
  const wsName = process.env.BOOTSTRAP_WORKSPACE || 'My Brand'

  // ── workspace + admin ──
  let workspace = await prisma.workspace.findFirst()
  if (!workspace) {
    const slug = `${wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ws'}-${crypto.randomBytes(3).toString('hex')}`
    workspace = await prisma.workspace.create({ data: { name: wsName, slug } })
    console.log(`+ workspace "${workspace.name}"`)
  }

  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (!existingUser) {
    await prisma.user.create({
      data: {
        email,
        name: 'Owner',
        passwordHash: passwordHash(password),
        role: 'owner',
        memberships: { create: { role: 'owner', workspaceId: workspace.id } },
      },
    })
    console.log(`+ admin user ${email}`)
  } else {
    const membership = await prisma.membership.findFirst({ where: { userId: existingUser.id, workspaceId: workspace.id } })
    if (!membership) await prisma.membership.create({ data: { userId: existingUser.id, workspaceId: workspace.id, role: 'owner' } })
  }

  // ── default brand voice ──
  const voiceCount = await prisma.brandVoice.count({ where: { workspaceId: workspace.id } })
  if (voiceCount === 0) {
    await prisma.brandVoice.create({
      data: {
        workspaceId: workspace.id,
        name: 'Default',
        persona: `You are the friendly social media manager for ${wsName}. You answer customers accurately, warmly and briefly. You only state facts that appear in the knowledge base or the post itself — if something is missing (price, stock, delivery date, order status), you say you'll follow up and ask for what you need instead of guessing. You never mention being an AI.`,
        tone: 'friendly, concise, helpful',
        emojiPolicy: 'sparingly',
        maxChars: 300,
        isDefault: true,
        examples: JSON.stringify([
          { comment: 'Price plz?', reply: "It's Rs 2,450 — free delivery over Rs 5,000. Want me to send the order link?" },
          { comment: 'My order still has not arrived', reply: "So sorry about the delay. DM us your order number and we'll track it right away." },
        ]),
      },
    })
    console.log('+ default brand voice')
  }

  // ── starter knowledge ──
  const knowledgeCount = await prisma.knowledgeItem.count({ where: { workspaceId: workspace.id } })
  if (knowledgeCount === 0) {
    for (const k of KNOWLEDGE) {
      await prisma.knowledgeItem.create({
        data: { workspaceId: workspace.id, kind: k.kind, title: k.title, question: k.question, body: k.body, tags: JSON.stringify(k.tags) },
      })
    }
    console.log(`+ ${KNOWLEDGE.length} starter knowledge entries (edit them in Knowledge base)`)
  }

  // ── starter safety rules ──
  const ruleCount = await prisma.safetyRule.count({ where: { workspaceId: workspace.id } })
  if (ruleCount === 0) {
    for (const r of SAFETY_RULES) {
      await prisma.safetyRule.create({ data: { workspaceId: workspace.id, ...r } })
    }
    console.log(`+ ${SAFETY_RULES.length} starter safety rules`)
  }

  // ── optional demo data ──
  // Demo data is on by default so a fresh install is explorable immediately.
  // Set SEED_DEMO=0 for a clean production seed.
  if (process.env.SEED_DEMO !== '0') {
    const accountCount = await prisma.account.count({ where: { workspaceId: workspace.id } })
    if (accountCount === 0) await seedDemo(workspace.id)
  }

  console.log('\nSeed complete.')
}

async function seedDemo(workspaceId: string) {
  const caps = {
    readComments: true,
    replyToComment: true,
    readDms: true,
    sendDm: true,
    privateReplyFromComment: true,
    webhooks: true,
    listContent: true,
    moderateComments: true,
  }

  const account = await prisma.account.create({
    data: {
      workspaceId,
      platform: 'instagram',
      platformUid: 'demo_ig_account',
      name: 'Demo Brand (sample data)',
      handle: '@demobrand',
      status: 'active',
      capabilities: JSON.stringify(caps),
      secrets: JSON.stringify({ demo: true }),
    },
  })

  await prisma.automationConfig.create({ data: { workspaceId, accountId: account.id } })

  const content = await prisma.content.create({
    data: {
      workspaceId,
      accountId: account.id,
      platformUid: 'demo_post_1',
      type: 'reel',
      text: 'New summer collection is live ☀️ Comment GUIDE and we will DM you the lookbook.',
      url: 'https://instagram.com/p/demo',
      publishedAt: new Date(Date.now() - 3 * 3600_000),
      metrics: JSON.stringify({ likes: 412, comments: 3 }),
    },
  })

  const samples = [
    {
      author: 'Ayesha K.',
      handle: '@ayesha.k',
      text: 'How much is shipping to Lahore?',
      confidence: 0.91,
      action: 'auto_send',
      status: 'scheduled',
      reply: 'Flat Rs 250 to Lahore, and free on orders above Rs 5,000 — usually 1-2 working days. Want the order link?',
      intent: 'question',
    },
    {
      author: 'Bilal',
      handle: '@bilal_99',
      text: 'I ordered 2 weeks ago and still nothing. This is unacceptable.',
      confidence: 0.31,
      action: 'escalate',
      status: 'pending',
      reply: "I'm really sorry about the delay — that's not the experience we want. Please DM your order number and we'll track it today.",
      intent: 'complaint',
      flagged: ['abuse_or_complaint_detected'],
    },
    {
      author: 'Sana',
      handle: '@sana.m',
      text: 'GUIDE',
      confidence: 0.88,
      action: 'auto_send',
      status: 'sent',
      reply: 'Sent you a DM with the full lookbook 💌',
      intent: 'purchase_intent',
      kind: 'private_reply',
    },
  ]

  for (const s of samples) {
    const comment = await prisma.comment.create({
      data: {
        workspaceId,
        accountId: account.id,
        contentId: content.id,
        platformUid: `demo_c_${Math.random().toString(36).slice(2, 9)}`,
        authorName: s.author,
        authorHandle: s.handle,
        text: s.text,
        permalink: content.url,
        platform: 'instagram',
        createdAt: new Date(Date.now() - 3600_000),
      },
    })
    await prisma.draft.create({
      data: {
        workspaceId,
        accountId: account.id,
        kind: (s as { kind?: string }).kind ?? 'comment_reply',
        commentId: comment.id,
        text: s.reply,
        alternates: JSON.stringify([]),
        confidence: s.confidence,
        intent: s.intent,
        sentiment: s.confidence < 0.5 ? 'negative' : 'neutral',
        language: 'en',
        reasoning: 'Seeded demo record.',
        action: s.action,
        status: s.status,
        flaggedFor: JSON.stringify((s as { flagged?: string[] }).flagged ?? []),
        llmProvider: 'demo',
        llmModel: 'demo-model',
        sentAt: s.status === 'sent' ? new Date() : null,
        scheduledFor: s.status === 'scheduled' ? new Date(Date.now() + 60_000) : null,
      },
    })
  }

  const thread = await prisma.thread.create({
    data: {
      workspaceId,
      accountId: account.id,
      platformUid: 'demo_thread_1',
      participantName: 'Hassan R.',
      participantId: 'demo_user_1',
      lastMessageAt: new Date(Date.now() - 900_000),
      firstInboundAt: new Date(Date.now() - 1800_000),
    },
  })
  const inbound = await prisma.message.create({
    data: {
      workspaceId,
      accountId: account.id,
      threadId: thread.id,
      platformUid: 'demo_m_1',
      direction: 'inbound',
      text: 'Hi, do you have the black one in medium?',
      senderName: 'Hassan R.',
      senderId: 'demo_user_1',
      createdAt: new Date(Date.now() - 900_000),
    },
  })
  await prisma.draft.create({
    data: {
      workspaceId,
      accountId: account.id,
      kind: 'dm_reply',
      messageId: inbound.id,
      threadId: thread.id,
      text: 'Yes — the black one is in stock in medium right now. Want me to hold one for you?',
      confidence: 0.64,
      intent: 'purchase_intent',
      sentiment: 'neutral',
      language: 'en',
      reasoning: 'Stock level is not in the knowledge base, so this is queued for review rather than auto-sent.',
      action: 'review',
      status: 'pending',
      llmProvider: 'demo',
      llmModel: 'demo-model',
    },
  })

  await prisma.usageStat.create({
    data: {
      workspaceId,
      accountId: account.id,
      day: new Date().toISOString().slice(0, 10),
      inboundComments: 3,
      inboundMessages: 1,
      autoSent: 1,
      llmCalls: 4,
    },
  })

  console.log(process.env.SEED_DEMO === '0' ? '- demo profile skipped (SEED_DEMO=0)' : '+ demo profile with sample comments, DMs and drafts')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

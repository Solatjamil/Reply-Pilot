# ReplyPilot

**AI social-reply automation for every platform.** ReplyPilot reads every comment and DM that lands on your brand's profiles, drafts a context-aware reply with an LLM grounded in *your* knowledge base and brand voice, scores how safe it is to post, and then either sends it automatically or drops it into a one-click approval queue for a human.

Think VistaSocial's inbox + ManyChat's "click to connect your page" onboarding + a guard-railed AI agent in the middle.

- **Platforms:** Instagram, Facebook Pages/Messenger, TikTok, YouTube, LinkedIn, X (Twitter)
- **Surfaces:** public comments, comment→DM private replies, and direct-message conversations
- **AI mode:** hybrid. The model drafts *everything*; automation only sends when confidence clears your threshold, the knowledge base actually covers the question, and no safety rule fires. Everything else waits for a human.
- **Stack:** Next.js 16 (App Router, TypeScript) · Prisma · PostgreSQL (SQLite for local dev) · Postgres-backed job queue

---

## Quickstart (5 minutes, no API keys needed)

```bash
npm install
npm run setup        # loads .env, picks sqlite/postgres, generates Prisma client, pushes schema, seeds demo data
npm run dev          # starts the app AND the queue worker in one process
```

Open <http://localhost:3000> and sign in with the seeded workspace admin:

| | |
|---|---|
| Email | `admin@replypilot.local` |
| Password | `replypilot123` |

`npm run setup` seeds a **demo Instagram account** with a post, three comments, one DM conversation and the drafts generated for them, so the inbox, approval queue, automations and analytics pages all have real data the first time you look at them.

### The zero-cost AI mode

`.env` ships with `AI_MOCK="1"`. That routes generation through a deterministic built-in mock provider so you can exercise the *entire* pipeline — webhook → ingest → safety → draft → scoring → routing → send — without spending a single token. Every mock reply is prefixed `[MOCK]` so it can never be mistaken for real output.

**Set `AI_MOCK="0"` the moment you add a real provider key.** With a key present and `AI_MOCK=0`, generation goes to your real model.

```bash
# in .env
AI_MOCK="0"
AI_PROVIDER="openai"        # openai | anthropic | google | groq | openrouter | ollama
OPENAI_API_KEY="sk-..."
```

`npm run dev` then restarts with the real provider. Check **Settings → Runtime** to confirm which provider is live.

---

## Connecting a real profile (ManyChat-style)

1. Create an app in the platform's developer console (links are on **Settings → Platform credentials**).
2. Put the client id/secret and verify token into `.env`.
3. Restart the server, then on **Accounts → Attach a new profile**, click the platform tile. You're redirected to the platform's OAuth consent screen; after approval ReplyPilot stores the encrypted tokens and lets you tick which pages/profiles to answer for.
4. Paste the webhook URL shown in **Settings → Webhooks** into the platform console and subscribe to the listed fields.

That's the whole flow — no manual token pasting, no per-platform code.

---

## How a reply is decided

```
inbound comment / DM
        │
        ▼
┌───────────────────────────┐
│ 1. DETERMINISTIC SAFETY   │  blocklist, PII, abuse/complaint, competitor,
│    (runs first, no LLM)   │  own-account, guaranteed-answer rules
└───────────────────────────┘
        │  blocked → ignore      flagged → escalate (human)
        ▼
┌───────────────────────────┐
│ 2. KNOWLEDGE RETRIEVAL    │  keyword + optional embedding search over
│                           │  your knowledge base, filtered by account
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 3. LLM DRAFT              │  brand voice + retrieved facts + conversation
│    (structured JSON out)  │  history + platform char limit + language match
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 4. AUDIT                  │  placeholders/AI disclosure, banned words,
│                           │  length, language mismatch
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 5. ROUTE                  │  confidence ≥ autoSendThreshold
│                           │  AND grounded in knowledge
│                           │  AND not flagged
│                           │  AND inside quiet hours + volume caps
│                           │  AND platform capability allows it
└───────────────────────────┘
   │                    │                   │
auto_send            review              escalate
(random human-like   (approval queue,    (human takes over,
 delay, then send)    1-click approve)    automation paused
                                          for the thread)
```

Nothing is sent that a human can't undo: every draft, decision, send, and failure is written to the **Activity log**, and any DM conversation can be handed to a human permanently with one click.

---

## Pages

| Route | What it does |
|---|---|
| `/` | Dashboard: awaiting-approval count, reply volume, automation health, cost |
| `/inbox` | Unified inbox. Tabs: approval queue, DMs, sent, escalated, ignored |
| `/accounts` | Connected profiles, per-account sync, capability badges, attach new profile |
| `/automations` | Per-account rules: auto-send on/off, confidence threshold, quiet hours, volume caps, delays |
| `/brand` | Brand voice: persona, tone, emoji policy, sign-off, banned words, style examples |
| `/knowledge` | Knowledge base the AI is allowed to use as facts (Q&A, policies, links) |
| `/analytics` | Reply volume, confidence distribution, auto vs human, response time, cost |
| `/logs` | Every webhook, job, draft decision, send and error |
| `/settings` | Runtime status, webhook URLs + verify tokens, platform credentials checklist, per-platform access notes |

---

## Running the worker

The queue is Postgres-backed (a `Job` table with `SELECT … FOR UPDATE SKIP LOCKED`-style claiming), so the worker can run anywhere.

```bash
npm run worker      # standalone worker process (recommended in production)
npm run dev         # dev also starts an in-process worker (ENABLE_INPROC_WORKER=1)
```

Job types: `process_webhook`, `generate_draft`, `send_draft`, `poll_content`, `poll_comments`, `poll_messages`, `refresh_token`, `embed_knowledge`, `sync_account`.

**Production:** run at least one `npm run worker` container per ~4 concurrency, and set `ENABLE_INPROC_WORKER=0` on the web containers so a web restart doesn't drop in-flight jobs. For multi-instance deployments, [pg-boss](https://github.com/timgit/pg-boss) is a drop-in upgrade path — see `docker-compose.yml`.

---

## Configuration

All configuration is environment-driven; `src/lib/env.ts` validates it at boot and fails loudly on a missing required value.

| Group | Keys | Notes |
|---|---|---|
| Core | `DATABASE_URL`, `APP_URL`, `APP_SECRET`, `AUTH_SECRET` | `APP_SECRET` derives the AES-256-GCM key that encrypts stored platform tokens. Rotating it invalidates every stored token. |
| Bootstrap | `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `BOOTSTRAP_WORKSPACE` | First admin created by `prisma/seed.ts` |
| AI | `AI_MOCK`, `AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `EMBED_MODEL` | Any one provider is enough; extra keys become automatic failovers in that order |
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_API_VERSION`, `IG_CLIENT_ID`, `IG_CLIENT_SECRET` | Covers Instagram + Facebook + Messenger |
| Others | `TIKTOK_CLIENT_KEY/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `YOUTUBE_API_KEY`, `LINKEDIN_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`, `X_BEARER_TOKEN` | Plus a `*_VERIFY_TOKEN` for each webhook |
| Worker | `WORKER_CONCURRENCY`, `POLL_INTERVAL_SECONDS`, `ENABLE_INPROC_WORKER` | |

See `docs/API_REFERENCE.md` for the full table, the platform-by-platform API map, and every internal REST endpoint.

---

## Platform reality check

This is the part most demos skip. Each platform gates automated replies differently, and ReplyPilot encodes those limits as **capabilities** per account so it never promises a send that will 403.

| Platform | Comment replies | DMs | Realtime webhooks | Main gate |
|---|---|---|---|---|
| Instagram | ✅ | ✅ (+ private reply from a comment, once, ≤7 days) | ✅ | App Review for `instagram_business_manage_messages` |
| Facebook Page | ✅ | ✅ Messenger | ✅ | App Review for `pages_messaging` |
| TikTok | ⚠️ partner-gated | ⚠️ Business Messaging, region-gated | ❌ (polling fallback) | Advanced Access + Business Center |
| YouTube | ✅ (top-level only) | ❌ no DM API exists | ❌ (polling) | Data API quota |
| LinkedIn | ✅ (pages + members) | ⚠️ partner-gated Messaging API | ❌ (polling) | Marketing Developer Platform |
| X | ✅ | ✅ | ✅ Account Activity | Pro/Enterprise tier |

**Settings → Platform access** documents each of these in-app, with the exact console link and the scopes to request. Adapters for gated capabilities are implemented but stay dormant until the credentials and access level exist — the UI shows why rather than failing silently.

---

## Security notes

- Platform tokens are encrypted at rest with AES-256-GCM (key derived from `APP_SECRET` via HKDF). They never leave the server except in the outbound API call.
- Webhook payloads are signature-verified per platform (Meta HMAC-SHA256 `X-Hub-Signature-256`, TikTok SHA-256 challenge, LinkedIn JWT, X CRC). If a signature arrives but `META_APP_SECRET` isn't set, the request is **rejected** rather than trusted — see the warning in the server log.
- Auth is email + password (scrypt) issuing an HTTP-only JWT session. Replace `src/lib/auth.ts` with your IdP before going multi-tenant in production.
- Rate limits are enforced client-side per account/endpoint with a token bucket, so a burst of comments can't get your app banned.

---

## Deploying

Full instructions, including Vercel/serverless specifics, are in **[`docs/DEPLOYING.md`](docs/DEPLOYING.md)**.

```bash
docker compose up -d --build     # Postgres + web + worker (seeds without demo data)
```

**On Vercel?** It works, but three things must be true: `DATABASE_URL` must be Postgres (the
filesystem is ephemeral, so SQLite cannot work), `NEXT_STANDALONE` must stay unset (it breaks
Vercel's builder), and there is no persistent worker — webhook-driven platforms stay
near-realtime via post-response draining, but platforms that only support polling (YouTube,
LinkedIn, TikTok) need Vercel Pro or an external scheduler. See the deploy guide.

or manually:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/replypilot" \
APP_URL="https://app.example.com" \
AI_MOCK=0 npm run db:push && npm run build
npm run start                    # web
ENABLE_INPROC_WORKER=0 npm run worker   # worker(s)
```

Put `APP_URL` behind HTTPS before connecting any real profile — every platform rejects `http://` webhook URLs and OAuth redirects.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | One-shot local setup: env check → provider sync → generate → db push → seed |
| `npm run dev` | Dev server + in-process worker |
| `npm run build` / `start` | Production build / serve |
| `npm run build:webpack` | Same build on the Webpack pipeline — use this on machines with <4 GB free RAM, where the default Turbopack build can stall |
| `npm run worker` | Standalone queue worker |
| `npm run db:push` | Sync Prisma schema to the database (switches provider based on `DATABASE_URL`) |
| `npm run db:seed` | Seed workspace + admin + brand voice + knowledge + safety rules + demo data. `SEED_DEMO=0` skips the demo data |
| `npm run db:studio` | Prisma Studio |
| `npm run test` | Unit tests (node:test) for the safety layer, routing policy, webhook parsers, signature verification and crypto |
| `npm run lint` | ESLint |

---

## Project layout

```
prisma/schema.prisma        data model (workspaces, accounts, content, comments,
                            threads, messages, drafts, jobs, usage, events)
prisma/seed.ts              bootstrap + demo data
src/app/(app)/              authenticated UI (inbox, accounts, automations, …)
src/app/api/                REST endpoints + webhook receivers
src/lib/ai/                 reply engine, prompts, safety layer, LLM clients
src/lib/platforms/adapters/ one adapter per platform (OAuth, read, send, webhook)
src/lib/worker/             queue runner + job handlers
src/lib/                    auth, crypto, db, env, http (rate-limited fetch)
docs/API_REFERENCE.md       platform API map, endpoints, env vars
docs/DEPLOYING.md           Docker / VPS / Vercel deployment guides
```

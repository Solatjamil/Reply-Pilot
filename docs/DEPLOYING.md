# Deploying ReplyPilot

ReplyPilot has two runtime halves: the **web app** (UI + API + webhook receivers) and the
**worker** (queue processing + polling). How you deploy depends on whether your platform can
keep a process alive.

| | Web app | Worker | Verdict |
|---|---|---|---|
| **Docker / VPS / Railway / Render** | ✅ | ✅ long-lived process | Full functionality — recommended |
| **Vercel / Netlify / Lambda** | ✅ | ⚠️ no persistent process | Works, with caveats below |

---

## Option A — Docker (recommended)

```bash
cp .env.example .env      # then edit: secrets, DATABASE_URL, APP_URL, an AI provider key
docker compose up -d --build
```

That starts Postgres, the web container and a worker container. The web container sets
`ENABLE_INPROC_WORKER=0` so a deploy or restart never drops an in-flight send; the worker
container owns the queue.

Scale the worker independently — jobs are claimed atomically, so extra workers are safe:

```bash
docker compose up -d --scale worker=3
```

## Option B — Any Node host

```bash
DATABASE_URL="postgresql://user:pass@host:5432/replypilot" npm run db:push   # once
npm run build
npm run start                        # web
ENABLE_INPROC_WORKER=0 npm run worker  # one or more workers
```

---

## Option C — Vercel

The web tier deploys to Vercel cleanly. Three things must be true.

### 1. Use Postgres, not SQLite

Vercel's filesystem is read-only and ephemeral, so `file:./dev.db` cannot work. Point
`DATABASE_URL` at any Postgres (Neon, Supabase, Vercel Postgres, RDS):

```
DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
```

`npm run build` and `npm run dev` both run `scripts/sync-provider.mjs` first, which rewrites
`prisma/schema.prisma` to `provider = "postgresql"` from that URL. **This matters**: Prisma
emits SQL in the dialect named in the schema, so generating a SQLite client and running it
against Postgres fails at runtime.

Create the tables and seed the admin user from your own machine — not at build time, since
Vercel discards the build container's filesystem:

```bash
DATABASE_URL="postgresql://…" npm run db:push
DATABASE_URL="postgresql://…" SEED_DEMO=0 npm run db:seed
```

### 2. There is no background worker

Serverless functions are frozen between requests, so a polling loop cannot run. ReplyPilot
adapts automatically when it detects Vercel:

- `src/instrumentation.ts` does **not** start the in-process worker.
- Webhook receivers ACK immediately (Meta requires a 200 within 5s), then drain the queue
  *after* the response via Next.js `after()` — see `src/lib/serverless.ts`. Webhook-driven
  platforms (Instagram, Facebook/Messenger, X) therefore stay near-realtime.
- `vercel.json` adds a daily cron on `/api/jobs/run` as a backstop for retries and for
  drafts whose human-like send delay had not yet elapsed.

**The cron schedule is the real constraint.** Vercel Hobby allows only *daily* cron jobs — a
more frequent expression fails the deployment outright:

> Hobby accounts are limited to daily Cron Jobs.

So on Hobby, platforms that have **no webhook API** (YouTube, LinkedIn, TikTok) are only
polled once a day. To fix that, either:

- upgrade to **Vercel Pro** and change `vercel.json` to `"schedule": "* * * * *"`, or
- keep the daily cron and point an **external scheduler** at
  `GET https://your-app.vercel.app/api/jobs/run` every few minutes (set `CRON_SECRET` in the
  Vercel env; the route accepts it as `?key=…` or as `Authorization: Bearer …`, which is what
  Vercel Cron sends), or
- run the worker on a small always-on host (Railway, Render, Fly, a $5 VPS) against the same
  Postgres, and let Vercel serve only the web tier. **This is the best option** — you get
  full realtime behaviour on every platform without Vercel Pro.

### 3. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** for Production (and
Preview if you use it):

| Required | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `APP_SECRET` | ≥32 random chars. Encrypts stored OAuth tokens — **rotating it later forces every profile to reconnect** |
| `AUTH_SECRET` | ≥32 random chars. Signs session JWTs |
| `APP_URL` | `https://your-app.vercel.app` — must be the real HTTPS URL or OAuth redirects and webhook URLs will be wrong |
| `CRON_SECRET` | Protects `/api/jobs/run` |
| `BOOTSTRAP_*` | Only needed if you seed from Vercel; normally you seed locally |

Then the AI provider and per-platform credentials you actually use — see the README table and
**Settings → Platform credentials** in the running app.

> **`AI_MOCK` must be `0` (or unset) in production.** With `AI_MOCK=1` every reply comes from
> the deterministic stand-in and is prefixed `[MOCK]`. The Settings page shows an amber banner
> while it is on.

### Deploy

```bash
npm i -g vercel
vercel link
vercel env add DATABASE_URL      # repeat for each variable
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard — the framework preset auto-detects
Next.js and `npm run build` is already correct.

**Do not set `NEXT_STANDALONE=1` on Vercel.** That flag makes `next.config.ts` emit the
self-contained bundle the Docker image needs, and it breaks Vercel's builder:

```
Error: ENOENT: no such file or directory, open '/vercel/path0/.next/next-server.js.nft.json'
```

Standalone output writes that trace file inside `.next/standalone/`, where Vercel does not
look for it. Nothing is set by default, so a plain Vercel deploy works.

### After deploying

1. Visit `/settings` — it is a live checklist. It confirms the AI provider, the database
   provider, whether `APP_URL` is public, and which platform credentials are still missing.
2. Copy each webhook URL from **Settings → Webhooks** into the matching developer console and
   subscribe to the listed fields.
3. **Accounts → Attach a new profile** to run the OAuth flow.
4. Turn `AI_MOCK` off once a real provider key is in place.

---

## Health checks and ops

| Endpoint | Purpose |
|---|---|
| `GET /login` | Cheap 200 for an uptime monitor |
| `GET /api/jobs/run?key=CRON_SECRET` | Drains the queue; returns `{ queued, running, failed, done }` counts |
| `GET /api/logs` (authenticated) | Queue stats, recent jobs, event log |
| `/logs` in the UI | Same, with per-job error messages |

Stuck jobs: `POST /api/accounts/{id}` with `{ "action": "retry" }` re-queues that account's
failed sends, and **Settings → Run queue now** drains immediately.

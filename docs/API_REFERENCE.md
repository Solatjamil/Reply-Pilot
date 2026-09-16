# ReplyPilot — API Reference

Two things live here:

1. **Platform API map** — exactly which third-party endpoints each adapter calls, which scopes/permissions they need, and what each platform actually permits. Read this before connecting a real profile.
2. **ReplyPilot REST API** — the internal endpoints the UI uses, plus the webhook receivers you register in each platform console.

---

## Part 1 — Platform API map

### 1.1 Instagram (via the Meta adapter)

| | |
|---|---|
| Login product | Instagram Login **or** Facebook Login with an IG Business/Creator account linked to a Page |
| Base URL | `https://graph.facebook.com/{META_API_VERSION}` (default `v23.0`) |
| Permissions | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `pages_show_list` |
| App Review | **Required** for `instagram_business_manage_messages` before non-tester accounts can DM |

**Read**

| Purpose | Call |
|---|---|
| Profile | `GET /me?fields=id,username,name,profile_picture_url,followers_count` |
| Recent media | `GET /me/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=25` |
| Comments on media | `GET /{media-id}/comments?fields=id,text,timestamp,from,like_count&limit=50` |
| Comment replies | `GET /{comment-id}/replies?fields=id,text,timestamp,from` |
| DM conversations | `GET /me/conversations?fields=participants,messages{message,from,created_time}&limit=20` |

**Write**

| Purpose | Call | Notes |
|---|---|---|
| Reply to a comment | `POST /{comment-id}/replies` (`message`) | Public reply |
| Private reply from a comment | `POST /me/messages` with `recipient: { comment_id }` | **Once per comment**, within **7 days**, exactly **1 message** |
| Reply in a DM thread | `POST /me/messages` with `recipient: { id: ig_user_id }` | Inside the **24-hour** window from the user's last message |
| Escalate to a human | `POST /me/messages` with `sender_action: "mark_seen"` + `tag: "HUMAN_AGENT"` | `HUMAN_AGENT` lifts the 24h window for 7 days |

**Webhooks** — object `instagram`, fields `comments`, `mentions`, `messages`, `messaging_postbacks`. Meta requires a `200` within **5 seconds**; ReplyPilot ACKs immediately and processes from the queue.

**Hard limits to design around:** 200 API calls/hour/user for Instagram API (24h rolling); 25 API calls per IG user per hour for content publishing; private replies are one-shot.

---

### 1.2 Facebook Pages + Messenger (via the Meta adapter)

| | |
|---|---|
| Permissions | `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_messaging`, `pages_read_user_content` |
| App Review | **Required** for `pages_messaging` (Messenger) and for Advanced Access to `pages_manage_metadata` |

**Read**

| Purpose | Call |
|---|---|
| Pages the user manages | `GET /me/accounts?fields=id,name,access_token,category` |
| Page feed | `GET /{page-id}/feed?fields=id,message,permalink_url,created_time,comments.limit(0).summary(true)` |
| Comments on a post | `GET /{post-id}/comments?fields=id,message,from,created_time,comments` |
| Conversations | `GET /{page-id}/conversations?fields=participants,updated_time,messages{message,from,created_time}` |

**Write**

| Purpose | Call | Notes |
|---|---|---|
| Reply to a comment | `POST /{comment-id}/comments` (`message`) | |
| Reply to a reply | `POST /{comment-id}/comments` | Same endpoint; nesting is limited to 2 levels |
| Private reply from a comment | `POST /{page-id}/messages` with `recipient: { comment_id }` | 7-day window, one message per comment |
| DM in a thread | `POST /{page-id}/messages` with `recipient: { id: psid }` | 24-hour standard messaging window |
| Human takeover | `POST /{page-id}/messages` with `sender_action: "typing_off"` + `recipient: { id }, tag: "HUMAN_AGENT"` | Pauses the Page Inbox handover protocol |

**Webhooks** — object `page`, fields `feed`, `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads`. Verify with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body using `META_APP_SECRET`).

---

### 1.3 TikTok

| | |
|---|---|
| Product | TikTok for Business / TikTok for Developers — **Business Account required** |
| Access level | **Advanced Access** approved through Business Center for Business Messaging and comment management |
| Region gating | Business Messaging is **not available** in the EEA, Switzerland, UK or India; US availability rolled out around Nov 2025. Verify current availability in the developer console for your market. |
| Webhooks | **None on the public APIs** → ReplyPilot falls back to polling `/v2/video/list/` |

**Read**

| Purpose | Call |
|---|---|
| User info | `GET /v2/user/info/?fields=open_id,display_name,avatar_url,follower_count` |
| Video list | `GET /v2/video/list/?fields=id,title,create_time,cover_image_url,like_count,comment_count&max_count=20` |
| Video comments | `GET /v2/video/comment/list/?video_id={id}&max_count=50` |
| Comment replies | `GET /v2/video/comment/reply/list/?comment_id={id}` |

**Write**

| Purpose | Call | Notes |
|---|---|---|
| Reply to a comment | `POST /v2/video/comment/reply/` (`video_id`, `comment_id`, `content`) | Partner-gated |
| Send a DM | `POST /v2/im/message/send/` (`conversation_id`, `content`, `content_type`) | Business Messaging; **user-initiated only** |

**Business Messaging constraints:** the business may only reply inside a **48-hour** window after the user's last message, capped at **10 messages** per window, ~**10 requests/second**. The business cannot start a conversation. Media message types are further region-limited.

**OAuth:** `https://www.tiktok.com/v2/auth/authorize/` with `client_key`, scopes `user.info.basic`, `video.list`, `video.publish` (as granted). Token exchange at `POST /v2/oauth/token/`. Refresh tokens are valid ~365 days; ReplyPilot enqueues `refresh_token` before expiry.

Because the endpoint paths for Business Messaging are only published to approved partners, the TikTok adapter reads its base path and messaging capability from config and stays **dormant** until Advanced Access credentials exist. Capability flags (`readComments`, `replyToComment`, `readDms`, `sendDm`) are what the UI and the send-guard actually check.

---

### 1.4 YouTube

| | |
|---|---|
| Product | YouTube Data API v3 |
| Base URL | `https://www.googleapis.com/youtube/v3` |
| Scopes | `https://www.googleapis.com/auth/youtube.readonly` + `youtube.force-ssl` for writing |
| Audit | Comment write access requires the YouTube API Services audit form for higher quota |

**Read**

| Purpose | Call |
|---|---|
| Channel | `GET /channels?part=snippet,statistics&mine=true` |
| Recent uploads | `GET /search?part=snippet&type=video&channelId={id}&order=date&maxResults=25` |
| Comment threads | `GET /commentThreads?part=snippet,replies&videoId={id}&maxResults=50&order=time` |
| Replies | `GET /comments?part=snippet&parentId={threadId}` |

**Write**

| Purpose | Call | Notes |
|---|---|---|
| Reply to a top-level comment | `POST /commentThreads` (`snippet.parentId`, `snippet.textOriginal`) | YouTube only allows replies to **top-level** comments |
| Reply within a thread | `POST /comments` (`parentId`, `textOriginal`) | |
| Set moderation status | `PATCH /comments` (`snippet.moderationStatus`) | `heldForReview` / `rejected` |
| Mark as spam | `POST /comments/setModerationStatus` | |

**Cost:** `commentThreads.list` = 1 unit, `comments.insert` = **50 units**, `comments.list` = 1 unit. Default daily quota is 10,000 units → budget roughly 150–200 posted replies/day unless you request an increase.

**No DMs.** YouTube has no messaging API of any kind, so the adapter reports `readDms: false, sendDm: false` and the UI explains it rather than showing a broken button.

**No comment webhooks** → polling on a schedule (`POLL_INTERVAL_SECONDS`).

---

### 1.5 LinkedIn

| | |
|---|---|
| API style | REST (`https://api.linkedin.com/rest/...`) with **versioned headers**; legacy v2 for some reads |
| Required headers | `X-Restli-Protocol-Version: 2.0.0`, `LinkedIn-Version: 202506` (any YYYYMM you're pinned to) |
| Programs | Community Management API / Marketing Developer Platform for org pages; **Messaging API is partner-gated** |

**Read**

| Purpose | Call |
|---|---|
| Member profile | `GET /v2/userinfo` (OpenID Connect) |
| Org pages you manage | `GET /rest/organizations?q=roleAssignee` |
| Org posts | `GET /rest/posts?q=author&author=urn:li:organization:{id}` |
| Comments on an object | `GET /rest/socialActions/{encodedUrn}/comments?q=comments&count=50` |

**Write**

| Purpose | Call | Body |
|---|---|---|
| Reply to a comment | `POST /rest/socialActions/{encodedUrn}/comments` | `{ actor, message, object }` |
| Reply to a reply | same | `object` = the nested comment URN |
| Like | `POST /rest/socialActions/{encodedUrn}/likes` | `{ actor, object }` |

The `{encodedUrn}` is URL-encoded, e.g. `urn%3Ali%3Acomment%3A(activity)-6374133487612345600-70000`.

`actor` is `urn:li:person:{id}` for a member or `urn:li:organization:{id}` for a page — ReplyPilot picks based on the account type.

**Scopes:** `r_organization_social`, `w_organization_social`, `r_member_social`, `w_member_social`, plus `rw_ads` for ads accounts. `w_member_social` comments require the member to have granted them.

**Messaging** is a separate partner program; without it the adapter reports `sendDm: false`.

**No comment webhooks** on the social actions API → polling org/member posts.

---

### 1.6 X (Twitter)

| | |
|---|---|
| Base URL | `https://api.x.com/2` |
| Auth | OAuth 2.0 user context (PKCE) for posting; OAuth 1.0a (`X_API_KEY` / `X_API_KEY_SECRET`) for Account Activity webhooks |
| Tier | Comment posting and DMs need **Basic or higher**; **Account Activity webhooks need Pro or Enterprise**. New signups are pay-per-use. |

**Read**

| Purpose | Call |
|---|---|
| Authenticated user | `GET /2/users/me?user.fields=id,username,name,profile_image_url` |
| User timeline | `GET /2/users/{id}/tweets?tweet.fields=created_at,public_metrics,referenced_tweets&max_results=25` |
| Tweet + replies | `GET /2/tweets/{id}?expansions=in_reply_to_user_id&tweet.fields=conversation_id` |
| Mentions | `GET /2/users/{id}/mentions` |
| DM conversations | `GET /2/dm_conversations?dm_conversation.fields=id` |
| DM events in a conversation | `GET /2/dm_conversations/{id}/dm_events` |

**Write**

| Purpose | Call | Body |
|---|---|---|
| Reply to a tweet | `POST /2/tweets` | `{ text, reply: { in_reply_to_tweet_id } }` |
| Quote tweet | `POST /2/tweets` | `{ text, quote_tweet_id }` |
| Send a DM | `POST /2/dm_events` | `{ dm_conversation_id, recipient_id, text }` |
| New DM conversation | `POST /2/dm_conversations` | `{ conversation_type: "Group", participant_ids, message: { text } }` |
| Delete a tweet | `DELETE /2/tweets/{id}` | |

**Character limit:** 280 for most accounts, 4,000 for Premium. ReplyPilot's `PLATFORM_CHAR_LIMITS.x = 280` and clamps + re-asks the model rather than truncating mid-word.

**Webhooks (Account Activity API):**

| Step | Call |
|---|---|
| Register | `POST /2/account_activity/webhooks/{env_name}.json?url={X_WEBHOOK_URL}` (OAuth 1.0a) |
| Validate | X sends `GET ?crc_token=...`; respond `{ "response_token": "sha256=" + base64(HMAC-SHA256(crc_token, consumer_secret)) }` within 3s |
| Subscribe a user | `POST /2/account_activity/webhooks/{env}/subscriptions/all.json` |

**Settings → Webhooks** has a per-account *Register X webhook* button that runs all three steps (`POST /api/x/register-webhook`). It only works on a paid tier with OAuth 1.0a keys present.

---

### 1.7 Capability matrix

`capabilities` is stored per account and is what actually gates sends — the UI and the worker both check it before attempting a platform call.

| Capability | IG | FB | TikTok | YouTube | LinkedIn | X |
|---|---|---|---|---|---|---|
| `readContent` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `readComments` | ✅ | ✅ | ⚠️ gated | ✅ | ✅ | ✅ |
| `replyToComment` | ✅ | ✅ | ⚠️ gated | ✅ | ✅ | ✅ |
| `privateReplyFromComment` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `readDms` | ✅ | ✅ | ⚠️ region | ❌ | ⚠️ partner | ✅ |
| `sendDm` | ✅ | ✅ | ⚠️ region | ❌ | ⚠️ partner | ✅ |
| `webhooks` | ✅ | ✅ | ❌ poll | ❌ poll | ❌ poll | ⚠️ Pro tier |

---

## Part 2 — ReplyPilot REST API

Base URL: `APP_URL`. All non-webhook endpoints require a session.

### 2.1 Authentication

Session = HTTP-only cookie `rp_session` holding a signed JWT (`AUTH_SECRET`). There is no API-key auth yet — add one in `src/lib/auth.ts` if you need machine access.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` | `{ ok, workspace }` + sets cookie |
| POST | `/api/auth/signup` | `{ email, password, name?, workspaceName? }` | `{ ok, workspace }` + sets cookie |
| POST | `/api/auth/logout` | — | `{ ok }` + clears cookie |

Passwords are hashed with scrypt (salt per user). Unauthenticated calls return `401 { "error": "Not authenticated" }`.

### 2.2 Accounts & OAuth

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/accounts` | List connected profiles with capabilities, counters, health |
| POST | `/api/accounts/{id}` | `{ action: "sync" }` enqueues a full sync; `{ action: "retry" }` re-queues failed sends |
| DELETE | `/api/accounts/{id}` | Disconnect (revokes the stored tokens, keeps history) |
| GET | `/api/oauth/{provider}/start` | Begin OAuth. `provider` ∈ `meta`, `meta_ig`, `tiktok`, `google`, `linkedin`, `x`. Redirects to the platform consent screen; if credentials aren't configured it redirects back to `/settings?error=…` |
| GET | `/api/oauth/{provider}/callback` | Platform redirect target. Exchanges the code, stores encrypted tokens, then renders the **profile picker** |
| POST | `/api/connect/finish` | `{ id, selected: string[] }` — attach the ticked pages/profiles as accounts. This is the ManyChat-style "choose which pages to answer for" step |
| POST | `/api/x/register-webhook` | `{ accountId }` — register + subscribe the X Account Activity webhook |

OAuth `state` is an HMAC-signed payload (`src/lib/oauth-state.ts`) carrying `{ wid, uid, provider, nonce }`, so a callback can't be replayed into another workspace.

### 2.3 Drafts (the approval queue)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/drafts?status=pending&limit=50` | `status` accepts a comma list (`pending,scheduled`) or `all`. Returns fully-shaped inbox items |
| POST | `/api/drafts/generate` | `{ commentId }` or `{ messageId }` — manually draft for something that was skipped |
| POST | `/api/drafts/{id}/decision` | Human decision, see below |

`POST /api/drafts/{id}/decision` body: `{ action, text?, reason?, sendNow? }`

| `action` | Effect |
|---|---|
| `approve` | Queues `send_draft`. With `sendNow: true` it runs immediately, otherwise on the automation's delay |
| `edit` | Requires `text`. `sendNow: true` edits and sends in one step |
| `reject` | Marks rejected, records `reason` |
| `ignore` | Marks ignored (spam, not for us) |
| `escalate` | Hands to a human, marks the thread `handedToHuman` |
| `handoff` | Pauses automation for the whole conversation |
| `regenerate` | Discards this draft and generates a fresh one (`force: true`) |

Responses: `{ ok, status }`, or `{ ok: false, error }` with `400/404/409`. A `403`-style refusal comes back as `{ ok: false, error: "<Platform> does not permit this action with your current API access." }` when the capability flag is off.

### 2.4 Automation, brand voice, knowledge, safety

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/automations` | Automation config per account |
| PATCH | `/api/automations` | Update one account's rules |
| GET/POST/DELETE | `/api/brand-voice` | Brand voices (persona, tone, emoji policy, sign-off, banned words, must-include, max chars, style examples, default flag) |
| GET/POST/DELETE | `/api/knowledge` | Knowledge base entries the AI may use as facts |
| GET/POST/DELETE | `/api/safety-rules` | Deterministic rules (`blocklist`, `escalate_keyword`, `guaranteed_answer`, `competitor`, `profanity`) |

`PATCH /api/automations` accepts:

```jsonc
{
  "accountId": "…",
  "replyToComments": true, "replyToDms": true, "replyToMentions": true,
  "autoSendEnabled": true,
  "autoSendThreshold": 0.82,      // 0–1, confidence required to auto-send
  "reviewThreshold": 0.45,        // below this → escalate instead of review
  "minDelaySeconds": 25, "maxDelaySeconds": 180,   // human-like send delay
  "maxAutoPerHour": 20, "maxAutoPerDay": 200,      // volume caps
  "maxRepliesPerUser": 3,
  "skipOwnComments": true, "skipRepliesToUs": true, "skipLowEffort": true,
  "quietHoursEnabled": true, "quietHoursStart": "22:00", "quietHoursEnd": "08:00",
  "timezone": "Asia/Karachi", "language": "en",
  "brandVoiceId": null, "sentiment": "all"
}
```

`POST /api/knowledge`:

```jsonc
{
  "kind": "faq",              // faq | policy | product | url | doc
  "title": "Shipping",
  "question": "how much is shipping?",   // optional, boosts retrieval
  "body": "Flat Rs 250 nationwide, free above Rs 5,000.",
  "tags": ["shipping"], "url": null, "weight": 10, "enabled": true
}
```

`POST /api/safety-rules`:

```jsonc
{
  "accountId": null,          // null = workspace-wide
  "kind": "guaranteed_answer", // blocklist | escalate_keyword | guaranteed_answer | competitor | profanity
  "pattern": "shipping",
  "matchType": "contains",    // contains | exact | regex | whole_word
  "response": "Flat Rs 250 nationwide, free above Rs 5,000.",
  "priority": 100, "enabled": true
}
```

### 2.5 Observability & ops

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/logs?limit=100&type=&level=` | Recent queue stats, jobs and events |
| GET | `/api/analytics?days=14` | Volumes, confidence distribution, auto vs human, response time, cost |
| POST | `/api/test-reply` | Brand-voice playground: `{ comment, platform?, kind?, post?, history? }` → scored draft, **nothing persisted** |
| POST | `/api/jobs/run` | Manually schedule polling + dispatch any drafts whose delay has elapsed |
| GET | `/api/jobs/run?key={CRON_SECRET}` | Same, for an external cron. With `CRON_SECRET` set this also drains the queue for up to 25s |

### 2.6 Webhook receivers

Register these URLs in each platform console. Every receiver ACKs fast and processes from the queue.

| Platform | URL | Verification |
|---|---|---|
| Meta (IG + FB + Messenger) | `GET/POST {APP_URL}/api/webhooks/meta` | GET: `hub.verify_token` must equal `META_VERIFY_TOKEN`, echoes `hub.challenge`. POST: `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(raw body, `META_APP_SECRET`) |
| TikTok | `GET/POST {APP_URL}/api/webhooks/tiktok` | GET: echoes `echostr` when `token` matches `TIKTOK_VERIFY_TOKEN`. POST: `x-tt-signature` / `X-Hub-Signature-256` HMAC-SHA256 of the raw body with `TIKTOK_CLIENT_SECRET` when both are present. Note TikTok publishes no public webhooks for these APIs — ingestion is by polling, and this receiver exists for partner-program apps |
| LinkedIn | `GET/POST {APP_URL}/api/webhooks/linkedin` | GET: echoes `hub.challenge` only when `hub.verify_token` matches `LINKEDIN_VERIFY_TOKEN` (403 otherwise; a param-less GET is a health check). POST: logged for inspection — LinkedIn does not deliver comment events outside the partner program, so ingestion is by polling. Add JWT/JWKS verification here before wiring up a partner app |
| X | `GET/POST {APP_URL}/api/webhooks/x` | GET: CRC challenge (`crc_token` → `sha256=` base64 HMAC with the consumer secret). POST: OAuth 1.0a request signature |

Subscriptions to request:

| Platform | Object | Fields |
|---|---|---|
| Instagram | `instagram` | `comments`, `mentions`, `messages`, `messaging_postbacks` |
| Facebook | `page` | `feed`, `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads` |
| X | Account Activity | `direct_messages`, `tweet_create_events` |

**Behaviour worth knowing:**

- If `META_APP_SECRET` is unset and a signature *is* present, the request is **rejected** (`500`) rather than silently trusted, and the reason is stated in the response and the server log. Unsigned requests with no secret configured are accepted in development with a loud warning.
- Unmatched payloads (no connected account for the uid) are logged as `webhook.unmatched` and dropped, never retried forever.
- Meta resolves one Facebook Login to a Page, its Messenger inbox and the linked Instagram account. All three can share a Page id, so account resolution falls back across the Meta family (`facebook_page` → `messenger` → `instagram`) before dropping an event.

---

## Part 3 — Environment variables

### Core (required)

| Key | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` or `postgresql://user:pass@host:5432/replypilot` | `npm run db:push` switches the Prisma provider automatically based on this value |
| `APP_URL` | `https://app.example.com` | Used to build OAuth redirects and webhook URLs. Must be HTTPS in production |
| `APP_SECRET` | 64+ random chars | Derives the AES-256-GCM key for stored tokens (HKDF). **Rotating it invalidates every stored token** |
| `AUTH_SECRET` | 64+ random chars | Signs session JWTs |
| `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD` / `BOOTSTRAP_WORKSPACE` | `admin@replypilot.local` / … | First admin created by the seed |

### AI

| Key | Notes |
|---|---|
| `AI_MOCK` | `1` = deterministic built-in mock provider, zero cost, replies prefixed `[MOCK]`. **Set to `0` in production** |
| `AI_PROVIDER` | `openai` \| `anthropic` \| `google` \| `groq` \| `openrouter` \| `ollama` |
| `AI_MODEL` | Model override, e.g. `gpt-4o-mini`, `claude-sonnet-4-5`, `gemini-2.0-flash` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | `OPENAI_BASE_URL` lets you point at any OpenAI-compatible gateway |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | |
| `GOOGLE_API_KEY` / `GOOGLE_MODEL` | Gemini |
| `GROQ_API_KEY` / `GROQ_MODEL` | Fast + cheap |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | One key, many models |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Local models; no key needed |
| `EMBED_MODEL` | Optional embedding model for semantic knowledge retrieval |

Any provider whose key is set becomes a **failover**: the primary is tried first, then the rest in order, and the error surfaces only if all of them fail.

### Platform credentials

| Platform | Keys |
|---|---|
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_API_VERSION` |
| Instagram Login | `IG_CLIENT_ID`, `IG_CLIENT_SECRET` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_VERIFY_TOKEN` |
| Google / YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_API_KEY` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_VERIFY_TOKEN` |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN`, `X_API_KEY`, `X_API_KEY_SECRET`, `X_WEBHOOK_URL` |

### Worker

| Key | Default | Notes |
|---|---|---|
| `ENABLE_INPROC_WORKER` | `1` | Set `0` on web containers in production and run `npm run worker` separately |
| `WORKER_CONCURRENCY` | `4` | Jobs claimed in parallel per worker process |
| `POLL_INTERVAL_SECONDS` | `120` | Polling cadence for platforms without webhooks |
| `CRON_SECRET` | — | Optional; protects `GET /api/jobs/run?key=…` |

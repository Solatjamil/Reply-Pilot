# ────────────────────────────────────────────────────────────────────────────
# ReplyPilot — web + worker image
#   docker build -t replypilot .
#   docker run -p 3000:3000 --env-file .env replypilot
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma needs a datasource URL at generate time; the runtime value is what
# actually matters (src/lib/db/adapter.ts reads DATABASE_URL on boot).
# `npm run build` runs scripts/sync-provider.mjs, which switches the schema's
# provider to postgresql from this URL — containers always run on Postgres.
ENV DATABASE_URL="postgresql://replypilot:replypilot@db:5432/replypilot"
ENV NEXT_TELEMETRY_DISABLED=1
# next.config.ts only emits the standalone bundle when this is set — Vercel and
# other non-container builds must leave it unset, or the deploy fails looking
# for .next/next-server.js.nft.json.
ENV NEXT_STANDALONE=1
# --webpack: the default Turbopack build needs more RAM than a small CI box has.
# Use `npm run build` here instead if your builder has 4 GB+ free.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm run build:webpack

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ENABLE_INPROC_WORKER=0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/src/generated ./src/generated
COPY --from=build --chown=nextjs:nodejs /app/worker.ts ./worker.ts
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

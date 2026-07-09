# Deployable image: Fastify API + pg-boss worker in one process
# (server/league-server.ts), serving the built web/ PWA from web/dist.
#
# Node 24 runs the TypeScript sources directly (type stripping) — same as CI
# and local dev, so there is no separate server build step to drift. The web
# client is the only thing compiled (Vite), in the build stage.
#
#   docker build -t fm-league .
#   docker run -p 8080:8080 -e HOST=0.0.0.0 -e DATABASE_URL=... -e SESSION_SECRET=... fm-league

FROM node:24-slim AS base
# pnpm pinned by the packageManager field in package.json
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ── build: full install (dev deps for vite/tsc), compile the PWA ─────────────
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY engine/package.json engine/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @fm/engine --filter @fm/server --filter @fm/web
COPY engine/ engine/
COPY server/ server/
COPY web/ web/
RUN pnpm --filter @fm/web build

# ── runtime: prod deps only (engine is source-first with zero runtime deps) ──
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY engine/package.json engine/
COPY server/package.json server/
# web stays a workspace member (manifest only) so the lockfile matches; its
# deps are never installed here — only its dist is shipped
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter @fm/engine --filter @fm/server
COPY engine/ engine/
COPY server/ server/
COPY --from=build /app/web/dist web/dist

USER node
EXPOSE 8080
CMD ["node", "server/league-server.ts"]

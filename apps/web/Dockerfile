# Build from the repo root:
#   docker build -f apps/web/Dockerfile -t nia/web .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/auth packages/auth
COPY packages/db packages/db
COPY packages/ui packages/ui
COPY apps/web apps/web
# @nia/ui has no build step of its own (next.config.mjs's transpilePackages
# compiles its source directly) — only these three need a dist/ before
# `next build` can resolve them.
RUN pnpm -r --filter @nia/schemas --filter @nia/auth --filter @nia/db build
# next.config.mjs's outputFileTracingRoot is set to the repo root
# specifically so `output: "standalone"`'s file-tracing follows pnpm's
# workspace symlinks correctly from inside this monorepo build.
#
# API_INTERNAL_URL must be set here, at build time: Next.js's standalone
# output resolves next.config.mjs's rewrites() once during `next build` and
# freezes the result as a literal destination string inside the generated
# server.js — setting this env var on the container at runtime has no
# effect on that rewrite. This is safe to bake because the value is a fixed
# Docker-network hostname (docker-compose.prod.yml's niacore-api alias),
# identical in every environment — same contract as the connector aliases
# (DEPLOYMENT.md), not a real per-environment config value.
ENV API_INTERNAL_URL=http://niacore-api:4001
RUN pnpm --filter @nia/web build

FROM node:22-alpine AS runtime
RUN addgroup -S nia && adduser -S nia -G nia
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next.js standalone's server.js binds to $HOSTNAME when set, and Docker
# auto-sets HOSTNAME to the container id for every container — without this
# override the server only listens on the container's own bridge IP, never
# 127.0.0.1 or 0.0.0.0. That silently breaks this file's own HEALTHCHECK
# below (which targets 127.0.0.1), which in turn stops niacore-proxy from
# ever starting in docker-compose.prod.yml (it depends on niacore-web being
# healthy). Same fix already applied to langfuse-server in docker-compose.yml.
ENV HOSTNAME=0.0.0.0
# Standalone output mirrors the outputFileTracingRoot-relative path
# (repo-root-based), so the traced node_modules + apps/web/server.js land
# under apps/web/ here. Static assets and public/ aren't included in
# .next/standalone by design — Next.js docs call these out as separate
# manual-copy steps.
COPY --from=build --chown=nia:nia /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nia:nia /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nia:nia /repo/apps/web/public ./apps/web/public
USER nia
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health-web').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

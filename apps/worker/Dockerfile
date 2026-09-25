# Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t nia/worker .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/guardrails/package.json packages/guardrails/
COPY packages/db/package.json packages/db/
COPY packages/secrets/package.json packages/secrets/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/guardrails packages/guardrails
COPY packages/db packages/db
COPY packages/secrets packages/secrets
COPY apps/worker apps/worker
RUN pnpm -r --filter @nia/schemas --filter @nia/guardrails --filter @nia/db --filter @nia/secrets --filter @nia/worker build
# Self-contained deploy: packages @nia/worker + its resolved production
# deps (including the workspace @nia/schemas, @nia/guardrails, @nia/db and
# @nia/secrets deps, materialized from their own dist/) into one flat
# directory — see apps/worker/.npmignore, packages/schemas/.npmignore,
# packages/guardrails/.npmignore, packages/db/.npmignore, and
# packages/secrets/.npmignore for why an (empty) .npmignore is required
# in every package `pnpm deploy` touches: its file-selection otherwise
# falls back to the root .gitignore's blanket `dist/` rule, silently
# deploying without the build output.
RUN pnpm --filter=@nia/worker --prod deploy /out

FROM node:22-alpine AS runtime
RUN addgroup -S nia && adduser -S nia -G nia
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=nia:nia /out ./
USER nia
# No EXPOSE/HEALTHCHECK: this is a pure BullMQ consumer (see src/index.ts's
# header comment) with no HTTP server and therefore no health endpoint to
# probe.
CMD ["node", "dist/index.js"]

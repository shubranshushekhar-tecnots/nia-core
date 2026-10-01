# Build from the repo root:
#   docker build -f apps/agent/Dockerfile -t nia/agent .
#
# This image is for a customer's own infrastructure (GMS's on-premise
# host), not Nia's own docker-compose stack — see
# docs/plans/planometry-integration.md §9 "Packaging" and
# docs/pilot/gms-install-guide.md. All agent state (config, encrypted
# secrets, spool, logs, status) lives under /data, which must be mounted
# as a persistent volume so it survives container restarts/upgrades.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/extract/package.json packages/extract/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/extract packages/extract
COPY apps/agent apps/agent
RUN pnpm -r --filter @nia/extract --filter @nia/agent build
# Self-contained deploy: packages @nia/agent + its resolved production deps
# (including the workspace @nia/extract dep, materialized from its own
# dist/) into one flat directory — see apps/agent/.npmignore and
# packages/extract/.npmignore for why an (empty) .npmignore is required in
# every package `pnpm deploy` touches: its file-selection otherwise falls
# back to the root .gitignore's blanket `dist/` rule, silently deploying
# without the build output.
RUN pnpm --filter=@nia/agent --prod deploy /out

FROM node:22-alpine AS runtime
RUN addgroup -S nia && adduser -S nia -G nia
WORKDIR /app
ENV NODE_ENV=production
# Overrides config/paths.ts's default (/etc/nia-agent), which the non-root
# `nia` user below can't write to — /data is created world-writable-by-
# owner for that user and is the one directory that must be mounted as a
# persistent volume (docker run -v nia-agent-data:/data ...).
ENV NIA_AGENT_HOME=/data
RUN mkdir -p /data && chown nia:nia /data
COPY --from=build --chown=nia:nia /out ./
USER nia
VOLUME ["/data"]
# Runs as a separate short-lived invocation alongside the long-running CMD
# process (apps/agent/src/cli/healthcheckCommand.ts) — inspects on-disk
# state only, no IPC into the running process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node dist/index.js healthcheck || exit 1
CMD ["node", "dist/index.js", "start"]

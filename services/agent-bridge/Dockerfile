# Build from the repo root:
#   docker build -f services/agent-bridge/Dockerfile -t nia/agent-bridge .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/db/package.json packages/db/
COPY packages/secrets/package.json packages/secrets/
COPY packages/guardrails/package.json packages/guardrails/
COPY services/agent-bridge/package.json services/agent-bridge/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/db packages/db
COPY packages/secrets packages/secrets
COPY packages/guardrails packages/guardrails
COPY services/agent-bridge services/agent-bridge
RUN pnpm -r --filter @nia/schemas --filter @nia/db --filter @nia/secrets --filter @nia/guardrails --filter @nia/agent-bridge build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4040
CMD ["node", "services/agent-bridge/dist/index.js"]

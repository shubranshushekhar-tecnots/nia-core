# Build from the repo root:
#   docker build -f services/connector-mysql/Dockerfile -t nia/connector-mysql .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/secrets/package.json packages/secrets/
COPY services/connector-mysql/package.json services/connector-mysql/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/secrets packages/secrets
COPY services/connector-mysql services/connector-mysql
RUN pnpm -r --filter @nia/schemas --filter @nia/secrets --filter @nia/connector-mysql build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4010
CMD ["node", "services/connector-mysql/dist/index.js"]

# Build from the repo root:
#   docker build -f services/connector-mysql/Dockerfile -t nia/connector-mysql .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/db/package.json packages/db/
COPY packages/secrets/package.json packages/secrets/
COPY services/connector-mysql/package.json services/connector-mysql/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/db packages/db
COPY packages/secrets packages/secrets
COPY services/connector-mysql services/connector-mysql
RUN pnpm -r --filter @nia/schemas --filter @nia/db --filter @nia/secrets --filter @nia/connector-mysql build
# BUILD_HASH: content hash of this image's source, used by apps/api's
# connectorFreshness check to detect stale running containers. Must cover
# the exact same paths as the COPY list above — see scripts/
# compute-build-hash.mjs for why both sides must stay in sync.
COPY scripts/compute-build-hash.mjs scripts/compute-build-hash.mjs
RUN node scripts/compute-build-hash.mjs \
      packages/schemas/package.json packages/schemas/src \
      packages/db/package.json packages/db/src \
      packages/secrets/package.json packages/secrets/src \
      services/connector-mysql/package.json services/connector-mysql/src \
      > BUILD_HASH

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4010
CMD ["node", "services/connector-mysql/dist/index.js"]

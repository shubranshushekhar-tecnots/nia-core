# Build from the repo root:
#   docker build -f services/connector-mongodb/Dockerfile -t nia/connector-mongodb .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY services/connector-mongodb/package.json services/connector-mongodb/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY services/connector-mongodb services/connector-mongodb
RUN pnpm -r --filter @nia/schemas --filter @nia/connector-mongodb build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4020
CMD ["node", "services/connector-mongodb/dist/index.js"]

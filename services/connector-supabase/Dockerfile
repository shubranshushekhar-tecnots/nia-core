# Build from the repo root:
#   docker build -f services/connector-supabase/Dockerfile -t nia/connector-supabase .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/secrets/package.json packages/secrets/
COPY services/connector-supabase/package.json services/connector-supabase/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/secrets packages/secrets
COPY services/connector-supabase services/connector-supabase
RUN pnpm -r --filter @nia/schemas --filter @nia/secrets --filter @nia/connector-supabase build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4030
CMD ["node", "services/connector-supabase/dist/index.js"]

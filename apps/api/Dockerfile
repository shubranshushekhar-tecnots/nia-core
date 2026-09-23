# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t nia/api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY apps/api apps/api
RUN pnpm -r --filter @nia/schemas --filter @nia/api build
# Self-contained deploy: packages @nia/api + its resolved production deps
# (including the workspace @nia/schemas dep, materialized from its own
# dist/) into one flat directory — see apps/api/.npmignore and
# packages/schemas/.npmignore for why an (empty) .npmignore is required in
# every package `pnpm deploy` touches: its file-selection otherwise falls
# back to the root .gitignore's blanket `dist/` rule, silently deploying
# without the build output.
RUN pnpm --filter=@nia/api --prod deploy /out

FROM node:22-alpine AS runtime
RUN addgroup -S nia && adduser -S nia -G nia
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=nia:nia /out ./
USER nia
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

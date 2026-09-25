# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t nia/api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/secrets/package.json packages/secrets/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY packages/auth packages/auth
COPY packages/db packages/db
COPY packages/secrets packages/secrets
COPY apps/api apps/api
RUN pnpm -r --filter @nia/schemas --filter @nia/auth --filter @nia/db --filter @nia/secrets --filter @nia/api build
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
# Migration runner + files, so this image can migrate itself at container
# start (see docker-entrypoint.sh) — apps/worker deliberately does NOT get
# these, only apps/api migrates. `pg` is already a resolvable dependency of
# @nia/api's deployed node_modules (via @nia/db), so no extra install here.
COPY --chown=nia:nia scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=nia:nia supabase/migrations ./supabase/migrations
COPY --chown=nia:nia apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER nia
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]

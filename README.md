# Nia Core — Monorepo

Enterprise integration + workflow orchestration + ETL + AI-native platform.

## Layout

```
apps/
  web/                  # Next.js 15 (App Router) — FE + BFF (create below)
  worker/               # BullMQ consumer: compiler, chat pipeline, ETL, checks
services/
  connector-mysql/      # Fastify service, uniform contract, pool manager
packages/
  schemas/              # @nia/schemas — Zod: manifests, tabular shape,
                        # service contract, job payloads. The shared currency.
designs/                # Claude Design exports (already in repo)
```

## Setup

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install

# Create the web app (interactive scaffolds don't belong in a zip):
pnpm create next-app@latest apps/web --ts --app --tailwind --eslint \
  --src-dir --import-alias "@/*" --use-pnpm
# then in apps/web: pnpm add @xyflow/react @tanstack/react-query zustand zod @nia/schemas@workspace:*
# and set  output: 'standalone'  in next.config.ts (self-hosting moat)

cp .env.example .env
docker compose up -d redis dev-mysql   # spine + scratch DB
pnpm --filter @nia/schemas build       # build shared package once
pnpm dev                               # turbo runs all dev tasks
```

## Observability (Langfuse)

Self-hosted Langfuse (v2 single-container server + its own Postgres) traces
`apps/worker`'s chat pipeline — one trace per chat job, one span per
LangGraph node, one generation per LLM call. See
`apps/worker/src/lib/observability/langfuse.ts` for the tracing model.

**One-time setup:**
```bash
docker compose up -d langfuse-server langfuse-db
# wait for it to report healthy, then open http://localhost:3005
```
That's it — `docker-compose.yml`'s `LANGFUSE_INIT_*` vars auto-provision a
dev org, project, user, and the project's public/secret SDK keypair on
first boot (idempotent; skipped on subsequent `up`s). The provisioned
keypair is already the value committed in `.env.example` /
`apps/worker/.env.example` (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`),
so `cp .env.example .env` (both root and `apps/worker/`) is all that's
needed to point the worker at it — nothing to copy out of the UI for local
dev. Sign in to the UI at `http://localhost:3005` with
`LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD` (see
`docker-compose.yml`) to browse traces.

For any non-local deployment: regenerate `NEXTAUTH_SECRET`/`SALT`/
`ENCRYPTION_KEY` and every `LANGFUSE_INIT_*` value in `docker-compose.yml`
(or run the hosted/managed Langfuse and skip this compose block entirely),
and set the real keypair via `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` —
never commit real values.

Tracing degrades to a no-op (worker runs fine, falls back to
`console.warn` for the one structured event it emits) when
`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are unset — Langfuse is
optional infrastructure, not a hard dependency.

## Rules the code already encodes

- **Secrets never cross worker → service.** Services resolve Vault refs themselves
  (`pool-manager.ts`); payloads carry only `credentialRef`.
- **Pools keyed `connectionId:credVersion`** — rotation bumps the version, stale pools age out.
- **Two queues** (`interactive`, `heavy`) so backfills never starve chat.
- **Every /execute returns the normalized tabular shape** with `executedQuery` in meta —
  that string is what citations and audit logs carry.
- **Write verbs are data, not code**: `WRITE_OPERATIONS` in `@nia/schemas` is the single
  list every layer (UI, API, RLS-adjacent checks) consults.

## Next milestones (delivery sequence)

1. Connector services + pooling (this scaffold's stub → real Vault resolution)
2. Manifest marketplace (Install → Connect, @handles)
3. Builder Phase A (React Flow canvas, Checks, Logs over SSE)
4. Write grants + ETL (checkpointed backfills; exit test: 1M rows surviving a worker restart)
5. Copilot (plan → ghost preview → apply)

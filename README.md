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

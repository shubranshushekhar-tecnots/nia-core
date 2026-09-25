# Nia Core — Monorepo

Enterprise integration + workflow orchestration + ETL + AI-native platform.

## Layout

```
apps/
  web/                  # Next.js 15 (App Router) — FE + BFF, port 3100
  api/                  # Express BFF service, port 4001
  worker/               # BullMQ consumer: compiler, chat pipeline, ETL, checks
services/
  connector-mysql/      # Fastify connector service, uniform contract, pool manager
  connector-mongodb/    # Fastify connector service
  connector-supabase/   # Fastify connector service
packages/
  schemas/              # @nia/schemas — Zod: manifests, tabular shape,
                        # service contract, job payloads. The shared currency.
  guardrails/           # SQL validation / query guardrails
  auth/                 # @nia/auth — Better Auth instance + session helpers
  db/                   # @nia/db — direct Postgres data access (replaces PostgREST)
  secrets/              # @nia/secrets — envelope encryption for connection/write-grant credentials
  ui/                   # design tokens (theme.css) + shared UI
```

## Remotes

`origin` is the personal GitHub repo (`shubranshushekhar-tecnots/nia-core`);
`company` is `naslabs-ai/niacore`. Both track `main` directly — no squashing,
no separate mirror branch. Bring `company` up to date with a normal
fast-forward push:

```bash
git push company main:main
```

`origin`'s `main-legacy` branch holds the pre-orphan `main` history for
reference (content-identical to the orphan root `main` was rebuilt from —
nothing was lost, see `docs/decisions.md`). See that file for the full story
of how the two repos ended up related this way.

## Prerequisites

- Node.js + [pnpm](https://pnpm.io) (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- [Docker](https://docs.docker.com/get-docker/) (local Postgres + sandbox DBs + connector services)

No Supabase CLI — Nia Core is a plain Postgres host (see
`docs/plans/local-dev.md`, `docs/decisions.md`). There's also no Supabase
Studio anymore; use any Postgres client (`psql`, TablePlus, etc.) pointed
at `DATABASE_URL` to browse the local database.

## Run locally

```bash
pnpm install

# 1. Local Postgres + Docker sandbox: redis + scratch source DBs + connector services
docker compose up -d postgres redis dev-mysql dev-mongo dev-postgres \
  connector-mysql connector-mongodb connector-supabase
# `postgres` runs the bootstrap in docker/local-postgres-bootstrap.sql on
# first boot (roles, pgcrypto, the auth schema shim) — see docker-compose.yml.

# 2. Apply migrations (supabase/migrations/*.sql, unmodified, tracked in
#    public._migrations — see scripts/migrate.mjs). Local-only step: the
#    built `apps/api` Docker image migrates itself on container start
#    instead (see DEPLOYMENT.md's "Migrations" section for that flow and
#    for recovering a FAILED migration via `migrate:resolve`).
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/postgres" pnpm run migrate:push

# 3. Env files — copy every .env.example, then fill in the values
#    (DATABASE_URL as above; no SUPABASE_* keys needed anymore)
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env

# 4. Seed fixture users through the real Better Auth signup path
pnpm --filter @nia/api seed:fixtures

# 5. Build the shared packages once, then run everything
pnpm --filter @nia/schemas --filter @nia/guardrails build
pnpm dev                        # turbo runs dev for every workspace
```

Services and ports once running:

| Service | Port |
| --- | --- |
| `apps/web` (Next.js) | 3100 |
| `apps/api` (Express BFF) | 4001 |
| `apps/worker` | background (BullMQ consumer, no HTTP port) |
| connector-mysql / connector-mongodb / connector-supabase | see `docker-compose.yml` |
| Langfuse UI (optional, see below) | 3005 |

> `apps/web` is run directly via `./node_modules/.bin/next dev -p 3100` from
> `apps/web/` rather than backgrounded — see the dev-server note in `CONVENTIONS.md`.

## Running tests

```bash
pnpm --filter @nia/web typecheck   # or: pnpm -r typecheck  (all workspaces)
pnpm -r test                       # unit tests, every workspace
pnpm run scripts:test              # root-level scripts, e.g. scripts/migrate.mjs
cd apps/web && PORT=3100 npx playwright test   # e2e (web app must be running)
```

RLS regression suite (run against local Postgres, wrapped in a
rolled-back transaction — never persists data):

```bash
psql "postgresql://postgres:postgres@localhost:5434/postgres" -f supabase/tests/rls_probes.sql
```

## Further documentation

- [`docs/decisions.md`](docs/decisions.md) — running log of architectural decisions
- [`docs/plans/`](docs/plans/) — per-phase implementation plans
- [`docs/history/`](docs/history/) — per-phase exit reports / session notes
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — landing-page build/design-port notes

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

- **Secrets never cross worker → service.** Services resolve secret refs
  themselves against `nia_secrets` (`pool-manager.ts`, `@nia/secrets`);
  payloads carry only `credentialRef`.
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

# Deployment

App-side production packaging for the infra team. This repo builds and
publishes images; infra owns hosting, orchestration, TLS, DNS, and scaling.

## Services

| Service | Image / Dockerfile | Build context | Start command | Port | Health check | Internal-only |
|---|---|---|---|---|---|---|
| `api` | `apps/api/Dockerfile` → `${REGISTRY}/nia-api:${TAG}` | repo root | `node dist/index.js` | 4001 | `GET /health` | No — the only service that should be publicly reachable |
| `worker` | `apps/worker/Dockerfile` → `${REGISTRY}/nia-worker:${TAG}` | repo root | `node dist/index.js` | — (no HTTP server; pure BullMQ consumer) | none (no HTTP surface) | Yes |
| `connector-mysql` | `services/connector-mysql/Dockerfile` → `${REGISTRY}/nia-connector-mysql:${TAG}` | repo root | `node services/connector-mysql/dist/index.js` | 4010 | `GET /health` | Yes |
| `connector-mongodb` | `services/connector-mongodb/Dockerfile` → `${REGISTRY}/nia-connector-mongodb:${TAG}` | repo root | `node services/connector-mongodb/dist/index.js` | 4020 | `GET /health` | Yes |
| `connector-supabase` | `services/connector-supabase/Dockerfile` → `${REGISTRY}/nia-connector-supabase:${TAG}` | repo root | `node services/connector-supabase/dist/index.js` | 4030 | `GET /health` | Yes |
| `redis` | `redis:7-alpine` (upstream, not built) | — | — | 6379 | `redis-cli ping` | Yes |

"Internal-only" means: no `ports:` published in `docker-compose.prod.yml`,
so the service is unreachable from outside the Docker host. It does
**not** mean no internet egress — see "Network requirements" below.

Build each app/worker image from the repo root, e.g.:
```
docker build -f apps/api/Dockerfile    -t $REGISTRY/nia-api:$TAG    .
docker build -f apps/worker/Dockerfile -t $REGISTRY/nia-worker:$TAG .
docker build -f services/connector-mysql/Dockerfile     -t $REGISTRY/nia-connector-mysql:$TAG     .
docker build -f services/connector-mongodb/Dockerfile   -t $REGISTRY/nia-connector-mongodb:$TAG   .
docker build -f services/connector-supabase/Dockerfile  -t $REGISTRY/nia-connector-supabase:$TAG  .
```
Push, then run the stack:
```
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

`apps/api` and `apps/worker` images are built via `pnpm --filter=<pkg>
--prod deploy` — a self-contained directory with only production
dependencies (including the resolved workspace deps, e.g. `@nia/schemas`),
running as a non-root user. The three connector images build the same way
they always have (whole-monorepo multi-stage build); this packaging pass
didn't change them.

## Environment variables

Full reference, one file per container, in this repo:
- `apps/api/.env.production.example`
- `apps/worker/.env.production.example`
- `services/connector-mysql/.env.production.example`
- `services/connector-mongodb/.env.production.example`
- `services/connector-supabase/.env.production.example`

Root `.env.production.example` is a *different* file: it's only the vars
`docker-compose.prod.yml` itself interpolates (image registry/tag, the
handful of required secrets shared across services). Copy it to
`.env.production` (gitignored) and fill it in — that's what you pass to
`docker compose --env-file`.

**Rule the compose file follows:** every var with no default in the app's
own env schema is required (`${VAR:?VAR is required}` — compose refuses to
start if it's unset) and is never hardcoded. Vars that already have a
sensible built-in default (timeouts, cron schedules, optional Langfuse
keys, etc.) are simply not passed through by the compose file at all —
they're documented in each per-service `.env.production.example` for
reference if you ever need to override one, but the shipped compose file
relies on the app's own default.

## Secret storage master key (`NIA_SECRET_MASTER_KEY`)

Every connection credential and write-grant credential (`nia_secrets`
table, `@nia/secrets` package — see `docs/decisions.md`'s secret-storage
migration entry) is envelope-encrypted under one shared master key,
`NIA_SECRET_MASTER_KEY`: 32 random bytes, base64-encoded. It must be
**byte-for-byte identical** across `api`, `connector-mysql`,
`connector-mongodb`, and `connector-supabase` (not `worker`, which never
decrypts a secret itself — it only forwards an opaque ref) — same
distribution rule as `WRITE_DISPATCH_SIGNING_SECRET`.

Generate one with:
```
openssl rand -base64 32
```

**Losing this key permanently loses every stored credential** — there is
no recovery path, by design (that's the whole point of the master key
never reaching Postgres). Back it up in whatever secret manager infra
uses for the other required secrets in `.env.production.example`, with
the same durability guarantees as a database backup, before ever running
this in production with real customer connections.

**Rotation** is not yet automated end-to-end — `apps/worker/scripts/
secrets-rotate.ts` is currently a stub that reports the `key_version`
distribution across `nia_secrets` and validates a candidate
`NIA_SECRET_MASTER_KEY_NEXT` parses, but does not yet perform a real
re-encryption pass. Until that ships, treat `NIA_SECRET_MASTER_KEY` as a
long-lived, infrequently-rotated secret, generated once per environment
and stored durably rather than one you can casually cycle.

## Migrations

A one-off release step — **never** runs on service startup (no service
`CMD`/entrypoint touches it).

```
DATABASE_URL="postgresql://...(percent-encoded)..." pnpm run migrate:status  # applied vs pending
DATABASE_URL="postgresql://...(percent-encoded)..." pnpm run migrate:push    # apply pending migrations
```
Equivalent containerized form (no local Node/pnpm needed — useful for a
release pipeline that only has `docker`; no Supabase CLI involved
anywhere in this — see `docs/decisions.md`):
```
docker build -f supabase/migrate.Dockerfile -t $REGISTRY/nia-migrate:$TAG .
docker run --rm -e DATABASE_URL="$DATABASE_URL" $REGISTRY/nia-migrate:$TAG status
docker run --rm -e DATABASE_URL="$DATABASE_URL" $REGISTRY/nia-migrate:$TAG push
```
CI dry-run check — fails if a migration file that's already applied to
`$DATABASE_URL` was modified in the current change (forward-only/additive
is a hard rule here, see below; this makes it a checked gate). Compares a
SHA-256 checksum of each file against what's recorded in `public.
_migrations` at apply time — only needs `DATABASE_URL`, no git checkout or
`jq`, so it also works via the `migrate` image above, not just on the CI
runner directly:
```
DATABASE_URL="..." pnpm run migrate:verify
```

**Migration compatibility rule:** migrations must be compatible with both
the old and new app code, since both run against the database during a
deploy (migration is applied, then the new image rolls out — the old one
is still serving traffic in between). Add a new column as nullable,
deploy, backfill, tighten (`NOT NULL`, drop a default, etc.) in a later
migration. Never drop or rename a column the currently-deployed code still
reads or writes. See `supabase/migrations/*.sql` for the existing pattern
and `supabase/tests/rls_probes.sql` for the RLS regression suite this
should stay paired with.

## Database connection pooling (`@nia/db`)

`packages/db` is the direct-Postgres data-access module (`pg` driver) that
replaces PostgREST call sites — see `docs/plans/data-access.md`. It connects
using `DATABASE_URL`, as the `postgres` role (the login role every app
service uses — never a customer-facing credential). There is one pool per process, not one per role:
privilege narrowing to `authenticated` (real end-user calls, via
`withActingUser`) or `service_role` (worker calls, via `withServiceRole`)
happens per-transaction with `SET LOCAL ROLE`, which reverts automatically
at `COMMIT`/`ROLLBACK` — so a pooled connection can never leak back to the
pool still impersonating a role.

Each service that imports `@nia/db` creates its own pool via
`createDbPool({ connectionString, max })`. Size `max` per service like any
other Postgres client pool — as a starting point, mirror what
`services/connector-supabase`'s pool manager already uses (a small pool per
process, not one shared across processes) and adjust from real connection-
count metrics once `api`/`worker` are actually migrated onto this module
(Step 3 of the plan above). TLS is auto-detected from the hostname (no TLS
for `localhost`/`127.0.0.1`/Docker-internal hosts, TLS otherwise) — no
separate `PGSSLMODE`-style env var to configure.

## Managed services needed

- **Postgres** (managed, e.g. Azure Database for PostgreSQL): a plain
  Postgres 17 instance — Nia Core is no longer a Supabase customer, it's
  just a Postgres host (see `docs/plans/local-dev.md`, `docs/decisions.md`).
  `DATABASE_URL` is the only var required to reach it. A fresh instance
  needs the same one-time bootstrap `docker/local-postgres-bootstrap.sql`
  applies locally (`pgcrypto`; the `anon`/`authenticated`/`service_role`
  roles, the latter with `BYPASSRLS`; a minimal `auth` schema with
  `auth.uid()`/`auth.role()` resolving identity from the
  `request.jwt.claims` GUC that `packages/db`'s `withActingUser` sets) —
  run that file once against the managed instance before the first
  `migrate:push`. Auth itself is Better Auth (`public.user`/`session`/
  `account`/`verification` tables, created by migration
  `0035_better_auth.sql`) — no separate hosted auth service.
- **Redis**: the `redis:7-alpine` container in `docker-compose.prod.yml`
  is sufficient as-is, or point `REDIS_URL` at a managed Redis instead and
  drop the `redis` service from the compose file.

## Network requirement: static outbound IP for connectors

`connector-mysql`, `connector-mongodb`, and `connector-supabase` make
outbound connections to **customer-owned** source/destination databases
(the whole point of the product), which are frequently IP-allowlisted on
the customer's side. Infra needs to put these containers behind a static,
known outbound IP (e.g. a NAT gateway with an Elastic IP, or equivalent)
so customers have one stable IP to allowlist — a dynamic/ephemeral egress
IP (default on most container platforms) will break as soon as it
rotates. This is unrelated to — and not satisfied by — the "internal-only,
no published port" property in the services table above; that's about
inbound reachability, this is about outbound identity.

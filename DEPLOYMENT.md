# Deployment

App-side production packaging for the infra team. This repo builds and
publishes images; infra owns hosting, orchestration, TLS, DNS, and scaling.

## Services

| Service | Image / Dockerfile | Build context | Start command | Port | Health check | Internal-only |
|---|---|---|---|---|---|---|
| `niacore-api` | `apps/api/Dockerfile` → `${API_IMAGE_VERSION}` | repo root | `docker-entrypoint.sh` (migrates, then `node dist/index.js`) | 4001 | `GET /health` | No — the only service that should be publicly reachable |
| `niacore-worker` | `apps/worker/Dockerfile` → `${WORKER_IMAGE_VERSION}` | repo root | `node dist/index.js` | — (no HTTP server; pure BullMQ consumer) | none (no HTTP surface) | Yes |
| `niacore-connector-mysql` | `services/connector-mysql/Dockerfile` → `${CONNECTOR_MYSQL_IMAGE_VERSION}` | repo root | `node services/connector-mysql/dist/index.js` | 4010 | `GET /health` | Yes |
| `niacore-connector-mongodb` | `services/connector-mongodb/Dockerfile` → `${CONNECTOR_MONGODB_IMAGE_VERSION}` | repo root | `node services/connector-mongodb/dist/index.js` | 4020 | `GET /health` | Yes |
| `niacore-connector-supabase` | `services/connector-supabase/Dockerfile` → `${CONNECTOR_SUPABASE_IMAGE_VERSION}` | repo root | `node services/connector-supabase/dist/index.js` | 4030 | `GET /health` | Yes |
| `niacore-redis` | `redis:7-alpine` (upstream, not built) | — | — | 6379 | `redis-cli ping` | Yes |

Service keys, `container_name`, and image-version vars all carry the
`niacore-` prefix; the one exception is the network alias each connector
also publishes (`connector-mysql` etc, no prefix) — that alias is a
hostname contract, see below, and must not be renamed.

"Internal-only" means: no `ports:` published in `docker-compose.prod.yml`,
so the service is unreachable from outside the Docker host. It does
**not** mean no internet egress — see "Network requirements" below.

**Connector service hostnames are a contract, not a naming convenience.**
`apps/api` and `apps/worker` never learn a connector's address from env or
compose — the host/port are hardcoded per connector type in
`packages/schemas/src/connectors/{mysql,mongodb,supabase,postgres}.ts`
(e.g. `service: { host: "connector-mysql", port: 4010 }`), and the one
override that exists (`CONNECTOR_DEV_HOST`) is dev-only — `apps/worker/src/
env.ts`'s `.refine()` refuses to boot with it set under
`NODE_ENV=production`. So in production, dispatch and freshness checks
(`apps/worker/src/lib/connectorClient.ts`, `apps/api/src/lib/
connectorFreshness.ts`) always resolve the literal hostnames
`connector-mysql` / `connector-mongodb` / `connector-supabase` on the
Docker network — regardless of what the compose service key or
`container_name` is actually called. Any rename (e.g. a `niacore-`
prefix convention) **must** keep those exact hostnames reachable via a
network alias:
```yaml
networks:
  niacore-network:
    aliases:
      - connector-mysql   # (or connector-mongodb / connector-supabase)
```
Renaming a connector service without adding this alias breaks every
connector dispatch and freshness check with a DNS resolution failure —
each container's own healthcheck will still pass (it only pings its own
`/health`), so this failure mode is invisible until something actually
tries to run a workflow.

Build each image from the repo root and push it, tagging however your
registry expects — these tags are exactly what you'll set as
`API_IMAGE_VERSION` / `WORKER_IMAGE_VERSION` / etc. below, e.g.:
```
docker build -f apps/api/Dockerfile                     -t ghcr.io/your-org/nia-api:1.4.0                .
docker build -f apps/worker/Dockerfile                  -t ghcr.io/your-org/nia-worker:1.4.0             .
docker build -f services/connector-mysql/Dockerfile     -t ghcr.io/your-org/nia-connector-mysql:1.4.0    .
docker build -f services/connector-mongodb/Dockerfile   -t ghcr.io/your-org/nia-connector-mongodb:1.4.0  .
docker build -f services/connector-supabase/Dockerfile  -t ghcr.io/your-org/nia-connector-supabase:1.4.0 .
```
Push each, then copy `.env.production.example` to `.env` in the deploy
directory, fill it in, and run the stack:
```
docker compose -f docker-compose.prod.yml up -d
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
`docker-compose.prod.yml` itself interpolates (image versions, the
handful of required secrets shared across services). Copy it to `.env`
(gitignored) in the deploy directory and fill it in.

**This `.env` file is read twice by Compose**, for two different reasons,
and it's easy to miss the second one: once automatically, to substitute
every `${VAR}` in `docker-compose.prod.yml` itself (this is the standard
behavior when a file literally named `.env` sits in the project
directory — no `--env-file` flag needed), and once *per service*, because
every service in the compose file also has `env_file: - .env`, which
injects the same file's contents directly into that container's
environment. Concretely: `${DATABASE_URL}` in the YAML's `environment:`
block gets substituted from `.env`, and separately, the raw `.env` file
is also mounted into the container as extra environment variables. Same
file, two mechanisms, both required — if you ever split this into
`.env.production` + a symlink, or pass `--env-file` pointing somewhere
else, the YAML substitution still works but every service's `env_file:`
silently stops finding anything and containers boot with only whatever
`environment:` explicitly set. Keep it as one literal `.env` file and
every variable `docker-compose.prod.yml` interpolates must be listed in
it, full stop — there's no such thing as a compose-only var here.

**Rule the compose file follows:** every var with no default in the app's
own env schema is required and passed through as a plain `${VAR}`
interpolation, never hardcoded. Vars that already have a sensible
built-in default (timeouts, cron schedules, optional Langfuse keys, etc.)
are simply not passed through by the compose file at all — they're
documented in each per-service `.env.production.example` for reference if
you ever need to override one, but the shipped compose file relies on the
app's own default.

**Trade-off worth knowing:** these are plain `${VAR}` interpolations, not
`${VAR:?VAR is required}` guards, so `docker compose up` itself never
refuses to start over a missing variable — an unset var just interpolates
to an empty string. Each container still fails fast on that empty value
(the Zod schemas in `apps/api`/`apps/worker`, or the equivalent checks in
each connector), but that means a missing variable shows up as a
container that starts and then immediately crash-loops, not as Compose
refusing to bring the stack up at all. Check `docker compose logs` for
the specific container on any unexpected crash-loop after a deploy.

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

Migrations run automatically at **`api` container start** —
`apps/api/docker-entrypoint.sh` runs `node scripts/migrate.mjs push` and
only `exec`s the actual server (`node dist/index.js`) if that exits `0`.
A half-migrated or blocked database can never serve traffic: a failed
`push` aborts the entrypoint before `exec`, so the container exits
non-zero and never becomes healthy. `worker` deliberately does **not**
migrate itself — only `api` does, so there's exactly one migrator, and
`push` additionally takes a Postgres session-level advisory lock for the
duration of the run so that multiple `api` replicas starting concurrently
(a rolling deploy, a crash-loop restart racing a fresh start, etc.)
serialize instead of racing each other's DDL.

Because `push` needs a real session (for the advisory lock and for
multi-statement DDL as one transaction), `DATABASE_URL` must be a
**direct or session-mode connection** — `scripts/migrate.mjs` refuses to
even connect if the URL looks like a *transaction-mode* pooler (port
`6543`), with a clear error naming why.

The check is on **port, not hostname**, deliberately. On Supabase, a
direct connection (`db.<ref>.supabase.co`, IPv6-only unless the IPv4
add-on is purchased) and Supavisor's pooler are different hosts, but
Supavisor's session mode and transaction mode are the *same* host — only
the port differs (`5432` session, `6543` transaction) — and Supavisor is
IPv4-only in both modes. Session mode dedicates one backend connection to
the client for the whole session, giving the same session-level
guarantees `push` needs (an advisory lock and a temp table both survive
across separate statements/transactions on that connection — verified
live against Supabase's Supavisor), so it's a valid, IPv4-reachable
substitute for the direct connection whenever the direct host's
IPv6-only-ness is what's blocking you. That's why the check doesn't match
on hostnames containing `pooler` — a hostname check would block session
mode along with transaction mode, even though only transaction mode is
unsafe. It would also be the wrong idea on a non-Supabase host: Azure
Database for PostgreSQL's hostname carries no "pooler" marker at all, so
a hostname check wouldn't catch a transaction-mode pooler put in front of
one either — anyone tempted to reinstate a hostname-based check should
know it's wrong in both directions. If your database's transaction pooler
uses a different convention than port `6543`, verify session-level state
(advisory locks, temp tables) survives across separate statements before
pointing `DATABASE_URL` at it — see `scripts/migrate.mjs`'s
`assertDirectConnection` for the live verification query used here.

The standalone image/scripts below remain available for manual or CI use
(`status`/`verify`/`resolve`) — `api`'s entrypoint only ever calls `push`:
```
DATABASE_URL="postgresql://...(percent-encoded, direct/session)..." pnpm run migrate:status  # applied / pending / FAILED
DATABASE_URL="postgresql://...(percent-encoded, direct/session)..." pnpm run migrate:push     # apply pending migrations
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

### Recovering from a failed migration

`public._migrations` tracks each migration's `started_at`, `finished_at`,
and `error`. A row inserted before a migration runs and left with
`finished_at` still null (Postgres itself already rolled back that
migration's own DDL transaction) means it failed — and **every subsequent
`push`, including the next `api` container start, refuses to proceed**
until it's resolved, rather than silently skipping ahead.

1. See it: `pnpm run migrate:status` prints `FAILED <name> started <ts> —
   <recorded error>` for that migration (or via the standalone image's
   `status` command).
2. Investigate and fix the root cause (a bad migration file typically
   needs a new migration or, if unreleased, editing in place — see the
   compatibility rule below).
3. Unblock the next push: `pnpm run migrate:resolve <version>` (e.g.
   `pnpm run migrate:resolve 0038`). This marks the row `rolled_back_at`
   (an audit record — there's no partial schema state to undo, Postgres
   already rolled that back) so the next `push` retries that version.
4. Re-run `pnpm run migrate:push` (or restart the `api` container).

**Migration compatibility rule:** migrations must be compatible with both
the old and new app code, since both run against the database during a
deploy (migration is applied, then the new image rolls out — the old one
is still serving traffic in between). Add a new column as nullable,
deploy, backfill, tighten (`NOT NULL`, drop a default, etc.) in a later
migration. Never drop or rename a column the currently-deployed code still
reads or writes, and never delete rows a live deploy still needs (see
`supabase/migrations/0035_better_auth.sql`'s header comment for a worked
example: it backfills `public.user` from `auth.users` under the same ids
instead of deleting and recreating). A migration already applied anywhere
that matters (e.g. production) must never be edited in place — add a new
one instead, since `migrate.mjs`'s checksum check will otherwise refuse to
push (see `verify` above). See `supabase/migrations/*.sql` for the
existing pattern and `supabase/tests/rls_probes.sql` for the RLS
regression suite this should stay paired with.

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
  `DATABASE_URL` is the only var required to reach it, and it **must be a
  direct or session-mode connection, not a transaction-mode pooler one**
  — `api` migrates itself at container start (see "Migrations" above),
  which needs a real session for the advisory lock and multi-statement
  DDL; a transaction-mode connection string (port `6543` by Supavisor/
  PgBouncer convention) is refused outright by `scripts/migrate.mjs` —
  based on port, not hostname (see "Migrations" above for why a hostname
  check is wrong on both Supabase and Azure). If the managed provider only
  exposes a transaction-mode pooler by default, use its direct-connection
  or session-mode variant/port for `DATABASE_URL` instead. A fresh
  instance needs the same one-time bootstrap `docker/local-postgres-bootstrap.sql`
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

# Planometry integration

## Background
Planometry (a planning tool) will read raw rows from customers' databases
through Nia. Nia stores no row data.

The first customer (GMS) runs **SQL Server 2008**, **7 databases**
(`SummitERP_*`), on a private LAN with no direct inbound reachability
from Nia's own infrastructure. SQL Server 2008 can't negotiate TLS 1.2+
and predates several SQL features newer servers support — see "SQL
Server 2008 compatibility" below.

Delivery mechanism — how rows actually reach Planometry — was undecided
between three options:

- **A. Hosted pull gateway** — Planometry pulls directly from a Nia-hosted
  endpoint.
- **B. On-premise Nia Agent** — a customer-hosted process (behind the
  customer's firewall, reaching their DB directly) runs the extract core
  and pushes/serves rows outward.
- **C. Relay** — an intermediary relay service sits between Nia and
  Planometry.

**Decided: Option B (on-premise Nia Agent, push mode) is now the main
path and is Phase 2's scope.** GMS's SQL Server sits on a private LAN
Nia can't reach inbound, so a hosted pull gateway (A) or relay (C) would
need an outbound tunnel from the customer's network regardless — an
on-premise agent that pushes rows out needs no inbound hole at all.
A/C remain available as alternate transports for a future customer whose
database is already reachable from outside, but aren't being built now.

Phase 1 (this document's main scope) builds a standalone reading core
with zero dependency on Nia's app/API/database, specifically so the
Phase 2 on-premise Agent can embed it unchanged, running entirely outside
Nia's own infrastructure on the customer's LAN.

**Supported database dialects (current + planned):** SQL Server,
PostgreSQL, MySQL. Only the SQL Server module is built in Phase 1;
PostgreSQL/MySQL dialect modules are not yet scoped.

**Per-connection database allow-list:** since one SQL Server instance
may host several databases GMS wants read (7, in GMS's case), and a
connection/credential key must never be assumed to have access to every
database on its server, the set of databases a given connection key may
read from is an editable allow-list per key (not inferred from the
server or hardcoded) — enforced by whoever owns connection config in a
later phase; the extract core itself stays unaware of any such list and
simply opens one connection per database (see "SQL Server 2008
compatibility" below).

## Contract
- **Catalog**: `{ generatedAt, sourceTimeZone, tables: [{ name, kind:
  table|view, columns: [{ name, type, nullable }], excluded: [{ name,
  nativeType, reason }] }] }`. Types: `text, number, date, datetime,
  boolean`. `name` is the exact identifier accepted back in an Extract
  request; anything else is rejected.
- **Extract**: `{ table, columns[], filter[] }` — filters are AND-joined.
  Operators: `eq, neq, gt, gte, lt, lte, in` (max 1000), `between [low,
  high], startsWith` (literal prefix, wildcards escaped), `isNull,
  isNotNull`. A filter column needn't be in `columns`. SQL is never built
  from outside input — identifiers only ever come from a catalog lookup
  (never free-form parsing), and values are always bound parameters.
- **Rows**: NDJSON, UTF-8. Line 1 is `{"columns":[{name,type}…]}`, sent
  immediately (sourced from the catalog, before the first row). Then one
  JSON array per row. Empty lines are keep-alives, emitted at least once
  every 30s while waiting. Success ends with `{"end":true,"rows":N}`.
  Failure mid-stream: `{"error":"…"}` then close, no trailer.
- **Values**: `number` = exact digits (never round-tripped through a
  float), `date` = `yyyy-MM-dd`, `datetime` = ISO 8601 UTC with `Z`
  (no-zone source values converted using `sourceTimeZone`), `boolean` =
  `true`/`false`, empty = `null`. No locale formatting.

## Phases
0. **Planning** (this document). Reuse map, stop only on contradiction.
1. **SQL Server reading core** — standalone package implementing the
   contract above for SQL Server. Detailed below. This is the only phase
   currently scoped/authorized.
2. **Delivery mechanism: on-premise Nia Agent (Option B), push mode** —
   decided as the main path (see Background). Scoped in detail below
   (planning only — not yet authorized to build).
3. **Hardening / additional dialects (PostgreSQL, MySQL)** — not yet scoped.
4. **GMS rollout** — not yet scoped.
5. *(reserved)* — not yet scoped.

Phases 2–5 are intentionally left unscoped here: only their existence and
rough ordering is agreed so far, not their implementation detail.

## Phase 1 — SQL Server reading core

### Rules
- Main folder only, branch `main`. No worktrees, no new branches.
- Build on what exists: reuse `packages/schemas` quoting/param/pushdown
  helpers, `packages/secrets`, and existing patterns where the shapes
  actually match (see the Step 1 reuse map for where they don't).
  Existing connectors, ETL runs, Copilot, canvas, learning-mode and all
  current behaviour stay unchanged.
- Commit at the end of each slice, only that slice's files.
- Tests per slice: only what changed + typecheck of touched packages. End
  of phase: full suites of every package + a fresh-Postgres from-zero run.
- New dependencies: only the SQL Server driver (`mssql`/`tedious`) is
  approved.
- Don't touch `apps/worker`, the Connections redesign files, or
  theme/sidebar files with uncommitted changes not made as part of this
  work.
- Never add SQL Server to the dev sandbox compose file without asking.
  Tests use a throwaway `mcr.microsoft.com/mssql/server` container.

### Slices
1. **Shared extract package** (e.g. `packages/extract`), standalone — no
   dependency on Nia's app, API or database: types, the five-type mapping
   interface, exact-value serializer, filter builder (reusing existing
   helpers where they fit, adding the missing operators), NDJSON writer
   (columns line, rows, keep-alive, trailer, error line).
2. **SQL Server module** inside it:
   - Catalog from `INFORMATION_SCHEMA`/`sys` views: tables and views,
     schema-qualified names (`dbo.vw_salesdata`), nullable, type mapping.
     `bit` → boolean; `uniqueidentifier` → text; `varchar/nvarchar/char/
     xml/time` → text; int types/`decimal/numeric/money/float/real` →
     number; `date` → date; `datetime/datetime2/smalldatetime/
     datetimeoffset` → datetime. Exclude `varbinary/image/geography/
     geometry/hierarchyid/sql_variant` with a reason.
   - Streaming: one query, `request.stream` with pause/resume
     back-pressure, never buffering the full result.
   - Exact values: select `decimal/numeric/money`, `bigint`,
     `datetime2`, `datetimeoffset` and `time` as text in the generated SQL
     so nothing is rounded.
   - Cancel: an `AbortSignal`; on abort call `request.cancel()` and
     confirm the query actually stops.
   - Optional row limit (for previews): `TOP (n)`, never `OFFSET`/`FETCH`
     (see "SQL Server 2008 compatibility" below).
   - SQL logins only for now. Windows Authentication needs (driver, OS,
     domain) reported in 3 lines, not built.
   - TLS: `encrypt` defaults to `true`; a connection may set `encrypt:
     false` for a LAN-only instance (SQL Server 2008's own default).
     Separately, `allowLegacyTls` (default `false`, clearly marked
     insecure in code and docs) lowers the minimum negotiated TLS
     version to 1.0 and the cipher security level, for a 2008 instance
     that can't do TLS 1.2+ at all — intended only for an on-premise
     Agent reaching the DB over a private, trusted LAN, never for any
     internet-facing path.
   - One connection = one database, always (no server-wide connection) —
     GMS's 7 `SummitERP_*` databases on one server are 7 separate
     connections/catalogs, not a single multi-database one.
3. **Fake Planometry client script**: takes an extract, reads the
   stream, verifies the columns line, row arrays, trailer count, handles
   keep-alive lines, can disconnect mid-stream.
4. **Test harness**: throwaway SQL Server container, seed tables + a
   large table (1M+ rows) + a deliberately slow view (`WAITFOR DELAY`).

### Mandatory tests
- Memory stays flat streaming 1M+ rows.
- Abort mid-stream → the query disappears from `sys.dm_exec_requests`
  within seconds.
- Slow view: keep-alive lines are written while waiting; rows stream
  correctly once they arrive.
- Exact values: `decimal(38,10)`, `money`, `bigint > 2^53`,
  `datetime2(7)`, `datetimeoffset`, `time`, and a no-zone datetime with a
  non-UTC `sourceTimeZone`.
- Hostile identifiers and filter values can't escape; unknown table is
  rejected; unknown column/operator is rejected.
- Every filter operator, including `isNull`, `isNotNull`, `between`,
  `in`, and `startsWith` with `%`/`_` in the value.
- Generated SQL (every CAST/CONVERT type path, every filter operator,
  `TOP (n)`, and the catalog's `INFORMATION_SCHEMA` queries) checked
  against a deny-list of SQL Server 2012+ syntax — `TRY_CAST`,
  `TRY_CONVERT`, `CONCAT`, `FORMAT`, `IIF`, `OFFSET`/`FETCH`,
  `STRING_SPLIT` — since the throwaway test harness runs SQL Server
  2022 and would never itself catch a 2008-incompatible regression.

### SQL Server 2008 compatibility (GMS)
GMS's 7 `SummitERP_*` databases run SQL Server 2008, so every generated
query must work there, not just on the SQL Server 2022 test harness:
- No `TRY_CAST`/`TRY_CONVERT`, `CONCAT`, `FORMAT`, `IIF`,
  `OFFSET`/`FETCH`, `STRING_SPLIT`, or any other syntax introduced in
  SQL Server 2012 or later. Previews use `TOP (n)`, never
  `OFFSET ... FETCH`. Text conversion of `decimal`/`money`/`bigint`/
  `datetime2`/`datetimeoffset`/`time` uses only CAST/CONVERT styles
  valid since SQL Server 2008 (or earlier) — see `buildSelectSql.ts`.
- Catalog queries use only `INFORMATION_SCHEMA.TABLES`/`COLUMNS`
  (available unchanged since SQL Server 2000), not any `sys.*` view or
  feature gated to a later version.
- TLS: SQL Server 2008 can't negotiate TLS 1.2+. `encrypt: false` (LAN-
  only, off by default) and the separate, explicitly-insecure
  `allowLegacyTls` option (TLS 1.0 minimum + OpenSSL `SECLEVEL=0`, off
  by default, documented as for private-network Agent use only) exist
  for this — see `connection.ts`.
- The module makes no single-database assumption: one connection = one
  database, so a server with several databases (GMS's 7) is just
  several independent connections/catalogs.

### End of phase
Full suites of every package + fresh-Postgres from-zero run (nothing
existing broke). 10-line report, then stop.

## Phase 2 — On-premise Nia Agent (push mode)

**Status: plan approved, build authorized.**

### 1. Shape
New `apps/agent` (Node/TypeScript), picked up automatically by
`pnpm-workspace.yaml`'s `apps/*` glob and turbo's `build`/`test`/
`typecheck` pipeline. Depends only on `@nia/extract` (and transitively
`mssql`) — **no** dependency on `@nia/db`, `@nia/secrets`, `@nia/schemas`,
`@nia/auth`, Postgres, Redis, or any Nia-hosted service. `@nia/extract`
is already fully standalone (types, catalog, filterBuilder,
valueSerializer, ndjsonWriter, the mssql module incl. streaming/
cancellation/exact-values, and `testing/planometryClient.ts`) — reused
unchanged. `@nia/secrets` is **not touched**: its `store.ts` is
hard-coupled to a Postgres pool + `withServiceRole` (Nia's own DB), which
the agent must never depend on, even transitively. The agent has its own
small, standalone crypto module instead (DECIDED — see Secrets below),
with its own tests; no shared package factored out of `packages/secrets`.

Module layout: `config/` (load/validate), `secrets/` (local store, new,
independent of `packages/secrets`), `planometry/` (HTTP client), `sync/`
(poll→extract→spool→upload orchestration + per-server concurrency),
`cli/` (connection add/test/list/remove, status), all on top of
`@nia/extract` directly. CLI argument parsing uses Node's built-in
`node:util` `parseArgs` — no new dependency for this. The only new
dependency is `undici` (explicit HTTP client with proxy-agent/custom-CA
support, since the Planometry calls need both and Node's global `fetch`
doesn't expose that configuration without it).

### 2. Config
One `agent.config.json` per install: a list of connections, each
`{ id, label, sqlserver: { host, port, database, encrypt, allowLegacyTls,
trustServerCertificate }, planometry: { baseUrl }, agentKeyRef }` —
`agentKeyRef` and the DB password are refs into the local secret store,
never inline. CLI: `agent connection add|test|list|remove`; `add`
validates by test-connecting and fetching a catalog once via
`@nia/extract`'s mssql module before writing anything. File lives in an
OS app-data dir (`%ProgramData%\NiaAgent` / `/etc/nia-agent`) with
restrictive permissions; the file itself holds no secrets, so it's safe
to back up/diff.

### 3. Secrets at rest — DECIDED
Own small crypto module, `node:crypto` only, no shared package with
`packages/secrets`, own tests: single-layer AES-256-GCM per secret under
one local master key (no per-secret data-key envelope layer the way
`packages/secrets` does for server-side rotation across many DB rows —
not needed for one local keyfile, kept simpler on purpose).

Master key: generated on first run, stored in a separate local keyfile,
locked down with OS file permissions (Windows ACL / Linux `chmod 600`
owned by the service account). **Accepted for v1** with its limits
documented here and in `TODO.md`: this is weaker than DPAPI/an OS
keychain (anyone with filesystem read access as the service account, or
root/Administrator, can read the key) but needs zero native deps and
works identically on both platforms. DPAPI (Windows) / OS keychain
(Linux) is tracked as later work, not built now. Logging goes through a
redaction wrapper; a test asserts a canary secret value never appears in
log output.

### 4. Push protocol
`planometry/client.ts` implements:
- `postCatalog` — at pairing, on schema-fingerprint change, or when a
  poll response sets `catalogRequested`.
- `pollWork` — honors `pollAfterSeconds` from the response, with small
  jitter so GMS's 7 connections don't poll in lockstep.
- `pushChunk` — ≤50,000 rows or ≤16MB gzipped (whichever threshold hits
  first), `X-Chunk-Seq` header, retried with the *same* seq on transport
  failure (exponential backoff + jitter), HTTP 409 = stop and discard
  the buffered chunk, mark the run failed locally.
- `reportComplete` / `reportFailed`.
- `heartbeat` — **DECIDED**: fired whenever nothing has been sent to
  Planometry for this run for 60s — both before the first chunk (a slow
  query/view with no rows yet) and between chunks (a large extract whose
  chunk upload + next-chunk-ready gap exceeds 60s). Any successful call
  to Planometry for this run (a chunk push, or the heartbeat itself)
  resets the 60s window. Endpoint path is config-overridable
  (`planometry.heartbeatPath`) until Planometry confirms it.

Each sync runs its extract exactly once per work item; only chunk
uploads retry, not the whole extract — see the spool design below, which
is what makes that possible (the DB query is already closed by the time
uploads/retries happen).

#### Spool-to-disk — DECIDED
The sync reads the extract once, as fast as the source allows, into
gzipped NDJSON chunk files (≤50,000 rows or ≤16MB gzipped each,
whichever threshold hits first) in a local spool directory, using
`@nia/extract`'s existing `streamExtract`/`NdjsonWriter` unchanged — the
chunk-file writer *is* the `write` callback passed to `NdjsonWriter`,
rotating to a new file each time a threshold is crossed. Once the query
finishes (or the current chunk file is complete and the next one is
needed), the DB connection/query is **closed before any upload begins**.
Chunks are then uploaded from disk in order with `X-Chunk-Seq`, with
their own retry/backoff loop — **upload retries never touch the
database**, only the already-written files on disk.

Cleanup: every spool file for a run is deleted after that run reaches a
terminal state (`complete`, a `409` abort, or `failed`). Before starting
a new sync, free disk space in the spool directory is checked
(`node:fs`'s `statfs`, cross-platform, no new dependency); if
insufficient for a conservative worst-case chunk size, the sync fails
clearly without ever opening the DB connection. Spool directory is
configurable (`agent.config.json`'s `spoolDir`, defaults under the same
app-data dir as the config file).

### 5. Concurrency — DECIDED
Two independent limits, as planned: (a) one in-flight sync per
connection (naturally serial, bounded by poll cadence), and (b) a
semaphore keyed by `host:port` (not connection id) shared across all
connections hitting the same physical SQL Server — default **1**
concurrent query per SQL Server instance (configurable), so GMS's 7
`SummitERP_*` connections never run more than one query at a time
against their one SQL Server 2008 box regardless of how many have
pending work.

### 6. Network
HTTPS/TLS 1.2+ to Planometry (this leg has no legacy-TLS concession,
unlike the DB leg). `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` respected. A
config field for a custom CA bundle PEM, for TLS-inspecting corporate
proxies.

### 7. Operations
Rotating local log files, never row data or secret values. `agent
status` CLI reading a small local state file (last sync/error per
connection, catalog fingerprint, uptime). Graceful shutdown triggers
`AbortSignal` on in-flight extracts (reusing Phase 1's existing
cancellation path), best-effort reports the run failed, exits clean.
Agent reports its own version on every poll. No auto-update mechanism
in this phase (manual reinstall) — flagged as later work.

### 8. Testing
A new fake Planometry **push** server (distinct from Phase 1's
NDJSON-stream `testing/planometryClient.ts`, which only verifies the
pull-model wire contract and is reused here solely as a secondary
in-test verifier, not the production consumer) implementing catalog/
poll/chunk/complete/failed + heartbeat, with fault injection: dropped
chunk, forced 409, slow/late response, duplicate chunk ack. Integration
tests reuse Phase 1's throwaway SQL Server container and existing
fixtures (seed tables, 1M+ row table, slow view) to drive the full
poll→extract→spool→upload→complete loop against real SQL Server + the
fake push server. Unit tests: chunker/spool thresholds, retry/backoff
and 409-abort, heartbeat start/stop boundary, per-server semaphore,
secrets round-trip, log redaction.

**Mandatory tests** (approved build authorization): end-to-end sync
against the SQL Server test container + fake server with an exact row
count match; a duplicate chunk ack is ignored (not double-counted/
double-retried); a dropped chunk is retried with the same seq; a 409
stops the run and cleans up its spool files; the slow view's heartbeats
keep a sync alive without Planometry timing it out; the DB query is
confirmed closed (gone from `sys.dm_exec_requests`, reusing Phase 1's
`queryTextRunning` helper) before any chunk upload begins; a shutdown
mid-sync reports the run failed to Planometry and cleans up its spool.

### 9. Packaging
Deferred until GMS IT confirms host OS:
- **Windows service** — single executable (Node 20+ single-executable-
  application or `pkg`), needs Windows Server 2016+ (current Node
  floor). Likely default given SQL Server 2008's era, but not assumed.
- **Linux service** — systemd unit, same packaging approach.
- **Docker image** — most portable/CI-consistent, but adds a Docker
  prerequisite a traditional Windows-shop IT team may not already have.

### 10. Pull mode (optional, later)
If GMS ever allows inbound HTTPS, expose `/v1/catalog` and `/v1/extract`
reusing Phase 1's NDJSON contract verbatim — only a thin HTTP listener +
auth (mTLS or bearer token) would be new. Not built now.

### 11. Build order — approved, commit each slice (CONVENTIONS.md rules)
a. `apps/agent` skeleton + config file + local secret store + CLI
   (connection add/test/list/remove).
b. Fake Planometry push server (catalog, work, rows, complete, heartbeat)
   with fault injection.
c. Catalog push + work polling + heartbeat loop.
d. Sync executor: extract → spool → upload (chunks, seq, retries, 409,
   complete/failed).
e. Operations: rotating logs (no row data, no secrets), `agent status`,
   graceful shutdown, version on poll.

Packaging (#9) waits for GMS's host OS — not part of this build. End of
phase: full suites + typecheck (throwaway containers only, never the dev
sandbox DB). 10-line report, then stop.

### Open questions (remaining — for Planometry/GMS, not blocking the build)
- Planometry: exact heartbeat endpoint path/method/body (we're guessing
  one, config-overridable).
- Planometry: exact lightweight, non-claiming auth-check endpoint for
  `agent doctor`'s "agent key accepted" check (we're guessing `GET
  /v1/ping`, config-overridable via `pingPath`). This check must never
  call the real work-poll endpoint (`GET /v1/work`), since that claims/
  dequeues an actual queued work item — confirmed by a dedicated test
  (`doctorChecks.test.ts`, "never claims/dequeues work").
- Planometry: `pollAfterSeconds` bounds/defaults, and whether our jitter
  is welcome or would confuse their rate-limiting.
- Planometry: does a duplicate ack for an already-committed chunk seq
  return 200 (idempotent), or something else — affects retry-dedupe (the
  fake server built in this phase treats it as idempotent 200; adjust
  once confirmed).
- GMS: host OS for the agent process (drives Packaging, #9).
- GMS: confirm the agent box's LAN reachability to all 7 SummitERP_*
  databases and outbound HTTPS egress/proxy requirements.

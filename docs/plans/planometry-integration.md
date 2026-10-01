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
   decided as the main path (see Background). Not yet scoped in detail.
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

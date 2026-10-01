# Planometry integration

## Background
Planometry (a planning tool) will read raw rows from customers' databases
through Nia. Nia stores no row data. The first customer (GMS) runs SQL
Server. How rows actually reach Planometry is still undecided — three
delivery options are on the table:

- **A. Hosted pull gateway** — Planometry pulls directly from a Nia-hosted
  endpoint.
- **B. On-premise Nia Agent** — a customer-hosted process (behind the
  customer's firewall, reaching their DB directly) runs the extract core
  and pushes/serves rows outward.
- **C. Relay** — an intermediary relay service sits between Nia and
  Planometry.

Phase 1 deliberately does not pick between A/B/C. It builds a standalone
reading core with zero dependency on Nia's app/API/database, so whichever
option is chosen later can embed it unchanged (in particular, Option B
requires the core to run outside Nia's own infrastructure entirely).

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
2. **Delivery mechanism** — decide A vs B vs C and build the chosen
   transport around the Phase 1 core. Not yet scoped.
3. **Hardening / additional dialects** — not yet scoped.
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
   - Optional row limit (for previews).
   - SQL logins only for now. Windows Authentication needs (driver, OS,
     domain) reported in 3 lines, not built.
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

### End of phase
Full suites of every package + fresh-Postgres from-zero run (nothing
existing broke). 10-line report, then stop.

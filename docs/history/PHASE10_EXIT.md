# Phase 10 exit report

Covers `docs/plans/phase10.md`. Full narrative and rationale:
`docs/decisions.md`'s "Phase 10 Step 1: MySQL DECIMAL-as-string bug is
connector-wide..." and "Phase 10 Step 3-4: the profiler..." entries.

## What shipped

- **Step 1 — MySQL DECIMAL-as-string scope check (bug found + fixed).**
  Phase 9 closed with an `expectedDivergence` scoped to the aggregate
  pagination path. Confirmed connector-wide: `services/connector-mysql/
  src/pool-manager.ts`'s `mysql.createPool(...)` never set mysql2's
  `decimalNumbers` option (defaults to `false`), so every DECIMAL/
  NEWDECIMAL column read through this connector — any query shape, not
  just the one aggregate case that surfaced it — comes back as a JS
  string. Fixed with `decimalNumbers: true` on the shared read/write pool
  (mirrors the existing node-postgres NUMERIC fix's float64 policy).
  Required `docker compose build connector-mysql && docker compose up -d
  connector-mysql`. Removed the now-stale `expectedDivergence` marker
  from `aggregate-pagination-numeric`; full `conformance:agreement` suite
  (219 cases) re-run clean.
- **Step 2 — inventory report.** Short pre-design scan of existing
  schema/entity plumbing (`introspection.ts`, `entityResolution.ts`,
  `IntrospectResponse`) to confirm what the profiler could reuse
  (connection resolution, entity lookup, dialect-native residual
  evaluator for parse-rate stats) vs. what needed to be new (sampling,
  stats, signature, cache).
- **Step 3A — sampling.** `apps/worker/src/lib/profile/sampleEntity.ts`:
  keyset head/tail (first 5,000 + last 5,000 rows) when the entity has a
  usable single-column primary key; a full-table scan when the table is
  smaller than the sample size; a single unordered page
  (`sampleMethod: "no-key-scan"`) when there's no usable key.
- **Step 3B — stats.** `apps/worker/src/lib/profile/stats.ts`:
  `computeColumnStats(name, declaredType, values)` — null/empty-string/
  whitespace-only/missing-token/distinct counts, numeric min/max or
  text min/max-length, and (for text columns) parse rates for each of
  `PARSE_STAT_KEYS` computed via the existing residual `evalExpr`
  coercion functions, with up to 3 failing examples per key.
- **Step 3C — signature and hash.** `apps/worker/src/lib/profile/
  signature.ts`: buckets each column's null presence (none/some/all) and
  each parse-rate's pass ratio into coarse, stable buckets before
  hashing, so ordinary sample-to-sample drift (adding a few more rows)
  doesn't change `profileHash`, while a genuinely new failure mode
  (a column's first unparseable value) does.
- **Step 3D — cache.** `supabase/migrations/0020_source_profiles.sql`
  (`source_profiles` table, RLS mirroring `workflow_check_runs`' org/
  personal-workspace scope), `apps/api/src/lib/profileQueue.ts` (BullMQ,
  same interactive-job shape as `schemaRefreshQueue`), 24h TTL, manual
  refresh bypasses the TTL.
- **Step 3E — UI.** `apps/web/src/components/canvas/ProfileTab.tsx`: a
  new "Profile" tab in the source node's config panel (only shown once
  an entity is selected), per-column cards (name/declared type, stat
  grid, parse-rate rows with a failing-examples tooltip), sample
  method/size/profiled-at header, and a Refresh button (async
  handler + local busy/error state, mirroring the existing WriteGrant
  confirm-flow pattern — no `useMutation` precedent exists in
  `canvas/`). Wired into `NodeDrawer.tsx`'s tab bar alongside the
  existing Field-mapping tab (independent `showMappingTab`/
  `showProfileTab` gates).

## Bugs found (beyond the plan's explicit scope)

1. **Postgres primary-key detection silently broken for every
   postgres/supabase connection (found + fixed).** Surfaced by the
   required `smoke:profile` live test (mysql passed, postgres alone
   reported `sampleMethod: "no-key-scan"` for a table that does have a
   single-column PK). `services/connector-supabase/src/index.ts`'s
   `/introspect` queried `information_schema.table_constraints` joined
   to `key_column_usage` — both are, per standard (if easy to miss)
   Postgres behavior, restricted to constraints on tables the querying
   role has a privilege on *other than SELECT*. Every real connection
   authenticates as the read-only `nia_ro` role, so this query has
   always silently returned zero rows, for every table, on every
   postgres/supabase connection — confirmed directly against
   `dev-postgres` as `nia_ro`: 0 of 214 pre-existing sandbox tables
   visible via the old query. This means keyset pagination
   (`entity.primaryKey` also gates the ETL runner's own keyset
   pagination, not just profiling) has been silently disabled for every
   postgres/supabase-backed connection since Phase 6 Block 3.5 —
   nothing before this phase exercised postgres `primaryKey`
   end-to-end. Fixed by switching to `pg_catalog` (`pg_index` joined to
   `pg_class`/`pg_namespace`/`pg_attribute`, filtered to `indisprimary`),
   which isn't subject to that privilege restriction. Verified as
   `nia_ro` before/after: 0 → 214/214 tables correctly report their PK.
   Required `docker compose up -d --build connector-supabase`.

## Open risks

- **Postgres/supabase keyset ETL pagination was never exercised
  end-to-end before this fix** — the bug above means every prior
  postgres/supabase workflow run that "looked like" keyset pagination
  was actually silently falling back to a single unordered page
  (`no-key-scan`) for entities without a *composite* key issue, or,
  worse, may have been silently truncating large postgres source tables
  to one page's worth of rows if any code path assumed `keyset-head-tail`
  ran but got `no-key-scan` instead without erroring. Worth an explicit
  live re-verification of a large-postgres-table workflow run
  (equivalent to the mysql/mongo kill-test coverage Phase 9 already has)
  early in whichever phase next touches postgres ETL pagination — not
  done here, out of this phase's scope (Step 4 deliberately kept tests
  to the listed minimal set).
- **`profile_hash` is advisory-only** — nothing reads it at run time yet.
  Tracked in `TODO.md` for Phase 13 (refuse/flag a run when the live
  entity's `profile_hash` drifts from the one a proposal was generated
  against).
- **No RLS probe added for `source_profiles`** — its policies mirror
  `workflow_check_runs`' existing pattern exactly, no new authorization
  shape introduced (see `docs/decisions.md`'s Phase 10 entry for the
  full reasoning).

## Verification

- Typecheck: `@nia/schemas`, `@nia/worker`, `@nia/api`, `@nia/web` — all
  clean. `@nia/connector-supabase` (not part of the normal typecheck
  pipeline, checked directly) — clean.
- Unit tests, no regressions: `@nia/schemas` 514/514 (20 files);
  `@nia/worker` 150/150 (19 files, includes this phase's 7 new profiler
  tests); `@nia/web` 10/10 (1 file, pre-existing, unrelated).
- `pnpm run smoke:profile` (new this phase) — seeds the same messy
  6-row table into real sandbox mysql/postgres/mongo, profiles each via
  `profileEntity()` directly against real connector services: 40/40
  assertions passed (sample size/method, column count, null/empty/
  whitespace/missing-token counts, `to_number`/`parse_date_iso` parse
  rates with failing examples, non-empty `profileHash`, 5-entry
  signature) — first run was 39/40 (the postgres PK bug above), 40/40
  after the fix.
- `conformance:agreement` full suite re-run clean after the Step 1 fix
  (219 cases, only the one pre-existing, unrelated XFAIL remains).

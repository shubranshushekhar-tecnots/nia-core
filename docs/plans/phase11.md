Phase 11 plan: staging, atomic apply, post-assertions, quarantine sink. After this, ETL is production-grade.
First, save this entire prompt verbatim to docs/plans/phase11.md, and re-read it if your context is compacted. Move fast: implement as written, and keep tests to the listed ones. Don't commit.

Step 0: Confirm Phase 10 and its follow-up are committed. The only uncommitted changes should be the known apps/web landing-page work; don't touch, stage, or commit it. STOP if anything else is uncommitted.

Step 1: Short inventory (report, then continue)
- Write modes that exist today (upsert by upsertKeys; any replace/full-load mode?) and how each destination dialect's writes are dispatched, including what guardrails validates on the write path.
- Which role the sandbox destinations are written with, and its privileges. If tests write as a superuser, add a production-equivalent write role for the step 3 smoke.
- Sandbox mongo topology: replica set or standalone.
- Where 8b-3's compile-time quarantine rejection lives.
STOP if any write path sends SQL that guardrails never validates.

Step 2: Design (implement as written)
A. Staging
- Every run writes to a per-run staging table, never directly to the destination. Chunks upsert into staging by the same upsertKeys, so a resumed run reuses its staging table and re-sent chunks stay idempotent. Persist the staging name with the run.
- Name: nia_stg_<short run hash>, independent of the destination's name (identifier length limits).
- Postgres/Supabase: create staging in a dedicated schema named nia, never in public. Enable RLS on each staging table at creation. Use CREATE TABLE ... (LIKE dest INCLUDING DEFAULTS INCLUDING INDEXES).
- MySQL: CREATE TABLE ... LIKE dest, in the destination's database.
- Mongo: a staging collection with the destination's indexes copied.
- Record every staging object in a new registry table in Nia's Supabase (run id, connection, schema, name, created_at, status). Drop staging after a successful apply and on terminal failure. Add a sweeper that drops registry entries older than 24 hours. Only ever drop names that are in the registry.

B. Atomic apply (not a rename swap)
- Apply staging to the destination in one destination transaction.
  - Upsert mode: INSERT ... SELECT FROM staging with ON CONFLICT / ON DUPLICATE KEY UPDATE.
  - Replace mode, if it exists: DELETE FROM dest, then INSERT ... SELECT FROM staging.
- Never rename tables: a rename swap detaches the destination's RLS policies, grants, views, triggers, and foreign keys.
- Mongo: apply inside a transaction on a replica set. On standalone mongo, refuse staged mode with a clear message pointing to direct mode.

C. Direct mode (explicit opt-out)
- Keep today's direct-write path as a per-destination setting, off by default, labeled non-atomic in the UI.

D. Preflight
- Before extraction, check that the destination role can create and drop in the staging location and write to the destination, that the nia schema exists (postgres), and that upsertKeys have a unique index. On failure, name the missing privilege and give the exact SQL to grant it. Put that setup SQL in the docs too.

E. Post-assertions against staging (before apply)
- Always: upsert-key columns contain no NULLs.
- Op modules declare their own assertions through the op registry, as they already declare pushability and residual mode. First one: aggregate asserts group keys are unique in staging.
- Optional maxFailureRate (0–1) on steps with onFailure: fail if failures / rows in exceeds it.
- Replace mode only: fail if staging holds fewer than 50% of the destination's current rows, unless the destination sets allowShrink.
- Any assertion failure fails the run, drops staging, and leaves the destination untouched. Record each assertion's result in the run events.

F. Quarantine sink
- Remove 8b-3's compile-time rejection. Quarantine stays residual-only.
- One quarantine table per destination database: nia_quarantine (in the nia schema on postgres). Columns: run_id, dest_table, step_id, function, input value (truncated), source row as JSON, status, created_at.
- Write quarantined rows with status 'pending'. The apply transaction marks the run's rows 'committed'. A failed run deletes its pending rows.
- Cap: 100,000 quarantined rows per run (configurable); exceeding it fails the run.
- Enable 'quarantine' in the onFailure select. The run result shows the quarantine count and table location.

Step 3: Tests (minimal; this is the full list)
- One smoke script, smoke:staged, with a postgres destination and a mysql destination, using the production-equivalent write role. Three scenarios:
  1. Happy path: the run applies; staging is dropped and its registry entry closed; a row failing a quarantine step lands in nia_quarantine as committed. On postgres, a pre-existing RLS policy and grant on the destination are still there after the run.
  2. Assertion failure (a NULL upsert key): the run fails, the destination is unchanged, staging is dropped, and no quarantine rows are committed.
  3. Kill after chunk 1 and resume (2,500 rows, chunk size 1000): the destination ends correct, and the same staging table was reused.
- Unit test: the staging DDL builder refuses any name not in the registry.
- The write path changed for every run, so run the existing write smokes once: smoke:write, smoke:write:mysql-mongo, smoke:extract:postgres. If sandbox mongo is standalone, set the mongo smoke to direct mode and note it.
- Typecheck all packages; run the schemas and worker unit suites.

Step 4: Close Phase 11
- docs/decisions.md: one Phase 11 entry covering the transactional apply (and why not a rename), the nia schema, direct mode, and the assertion set.
- TODO.md: quarantine pushdown, quarantine retention, row-count reconciliation, and mongo staged-mode testing if it was skipped.
- PHASE11_EXIT.md: short. What shipped, bugs found, open risks.

Output: step 1 findings, any deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.

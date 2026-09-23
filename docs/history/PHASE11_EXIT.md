# Phase 11 exit report

Covers `docs/plans/phase11.md`. Full narrative and rationale:
`docs/decisions.md`'s "Phase 11: staging, atomic apply, post-assertions,
quarantine sink..." entry.

## What shipped

- **Staging (Step 2A).** Every staged-mode run writes to a per-run
  staging table (`nia.nia_stg_<run-hash>` postgres/supabase;
  `<dest-db>.nia_stg_<run-hash>` mysql), never directly to the
  destination. Name derived deterministically from `runId`
  (`apps/worker/src/lib/etl/stagingRegistry.ts`'s `deriveStagingEntity`),
  so a resumed/redelivered chunk always lands on the same staging table
  without a lookup, and re-sent chunks upsert-in-place by the run's
  `upsertKeys` (idempotent). `staging_objects` registry table
  (`supabase/migrations/0021_staging_registry.sql`,
  `0022_staging_objects_dest_info.sql`) tracks every staging/quarantine
  object's run id, connection, schema, name, and status. A sweeper
  (`apps/worker/src/lib/etl/stagingSweeper.ts` +
  `stagingSweepSchedule.ts`) drops registry entries older than 24h, and
  only ever drops names actually present in the registry.
- **Atomic apply (Step 2B).** `services/connector-supabase/src/
  stagingSql.ts`'s `buildApplyFromStagingSql` runs the whole move inside
  one destination transaction: `INSERT ... SELECT FROM staging ... ON
  CONFLICT DO UPDATE` (upsert) or `DELETE FROM dest` + `INSERT ...
  SELECT` (replace). Deliberately not a rename/swap — that would detach
  the destination's RLS policies, grants, views, triggers, and FKs.
  Mongo's `/stage` refuses staged mode outright on this sandbox's
  standalone `mongod` topology, pointing callers at direct mode.
- **Direct mode (Step 2C).** Unchanged — still the existing per-
  destination opt-out, off by default.
- **Preflight (Step 2D).** `apps/worker/src/lib/etl/stagedWrite.ts`'s
  `runPreflight` checks the destination role can create/drop in the
  staging location and write to the destination, and that the `nia`
  schema exists, before extraction starts.
- **Post-assertions (Step 2E).** `noNullKeys` (upsert-key columns, always
  on), `uniqueColumns` (op-declared — aggregate asserts group-key
  uniqueness), `replaceShrinkGuard` (replace mode, unless
  `allowShrink`), `maxFailureRate` (evaluated from the quarantine count
  the apply transaction already holds). Any failure rolls back, drops
  staging, and leaves the destination untouched; each result is recorded
  in the run events.
- **Quarantine sink (Step 2F).** 8b-3's compile-time quarantine
  rejection removed — quarantine is residual-only again. One fixed
  `nia.nia_quarantine` table per destination database
  (`deriveQuarantineEntity`); rows write `pending` mid-run, flip to
  `committed` inside the same apply transaction that moves the real
  rows; a failed run deletes its own pending rows.

## Bugs found (both via live smoke tests, not smoke-script artifacts)

1. **Silent transaction rollback in the apply handler — the main bug.**
   The apply transaction's quarantine-commit UPDATE ran unconditionally
   whenever a `quarantineEntity` was present (true for every staged
   run), but `nia.nia_quarantine` was only ever created lazily by the
   `/write` endpoint's quarantine-write branch — never true for a run
   with zero quarantined rows. The UPDATE hit a nonexistent relation;
   the JS-level rejection was `.catch()`-swallowed, but Postgres had
   already marked the transaction aborted, so the following `COMMIT`
   silently rolled back everything (including the real apply INSERT)
   without raising an error. The connector reported `{ok:true,
   applied:N}` while the destination stayed empty. Root-caused via
   `pg_stat_user_tables` (`n_tup_ins` matched the claimed `applied`
   count exactly, but `n_live_tup:0`/`n_dead_tup:n_tup_ins`/
   `n_tup_del:0` — the signature of a rollback Postgres's stats
   collector still counted the inserts for). Fixed by making the
   `/stage` "create" op also idempotently create the quarantine table
   whenever a `quarantineEntity` is set (`services/connector-supabase/
   src/index.ts`), same `CREATE TABLE IF NOT EXISTS` posture as the
   staging table it already creates.
2. **Stale connector container, not a code bug.** After the fix above,
   re-running `smoke:write:mysql-mongo` failed on connector-mongodb
   alone ("write context signature is invalid or expired") because that
   container was still running a 3-hour-old image built before this
   session's signature-payload change (`runId`/`mode`/`stagingEntity`/
   `quarantineEntity` joined the signed `WriteContext`). `docker compose
   up -d --build connector-mongodb` resolved it. Lesson: any connector
   source change needs that connector's own container rebuilt before
   its verification is meaningful — a stale sibling can keep passing
   silently while masking a real signature/shape mismatch elsewhere.

## Deviations from the plan, with reasons

- No standalone unit test for "the staging DDL builder refuses any name
  not in the registry" — `stagingSql.ts` never re-validates identifiers
  itself (disclaimed in its own header comment); the real enforcement
  is `/stage`'s signed-`WriteContext` match check, already covered by
  `index.test.ts`'s signed-context tampering tests (mismatched
  `stagingEntity`/`runId`/`quarantineEntity`/`entity` each rejected). A
  second unit test at the SQL-builder layer would just re-assert the
  same contract.ts-level guarantee under a different name.
- `smoke:extract:postgres` (named in the plan) doesn't exist as a
  script; ran the closest equivalents already in the repo instead
  (`smoke:aggregate:postgres-source`), plus `smoke:write` and
  `smoke:write:mysql-mongo` per Step 3's "run the existing write smokes
  once."

## Open risks (see `TODO.md`'s Phase 11 entry for the full writeup)

- **Quarantine retention** — `nia.nia_quarantine` is one fixed,
  long-lived table with no TTL/archival policy; the 24h sweeper only
  covers `staging_objects`-registered staging tables.
- **Row-count reconciliation** — nothing automated cross-checks
  `workflow_runs.rows_processed` against the destination's actual
  post-apply row delta. A lightweight reconciliation assertion would
  have caught bug (1) above immediately instead of requiring a manual
  `pg_stat_user_tables` investigation.
- **Quarantine pushdown** — quarantine writes are row-by-row, no
  batching parity with the staging upsert path.
- **Mongo staged-mode apply is unverified against live infrastructure**
  — this sandbox's standalone `mongod` topology means `/stage` always
  refuses staged mode for mongo; actual apply-in-transaction behavior on
  a real replica set has never been exercised live. Not a skipped test
  so much as a capability gap in the current sandbox topology.

## Verification

- Typecheck: `@nia/worker` clean; `@nia/connector-supabase` clean.
- Unit tests, no regressions: `@nia/worker` 160/160 (19 files);
  `@nia/schemas` 520/520 (20 files); `@nia/connector-mysql` 22/22 (2
  files); `@nia/connector-mongodb` 17/17 (3 files, re-run clean after
  the container rebuild); `@nia/connector-supabase` 44/44 (6 files,
  incl. `index.test.ts`'s 20 `/stage`-route cases covering
  signed-context tampering).
- `pnpm run smoke:staged` (new this phase) — mysql source, **postgres
  destination only** (production-equivalent write role), all 3
  required scenarios: happy path (staging dropped, registry closed,
  atomic apply correct), assertion failure (NULL upsert key — a
  whole-transaction `noNullKeys` assertion rolls back before any row is
  written, destination untouched, staging dropped), kill-after-
  chunk-1-resume (2,500 rows / chunk size 1,000 — destination ends
  correct, same staging table reused across redelivery). 20/20
  assertions, all passed. Correction (Phase 13 follow-up): this script
  never exercises a mysql *destination*, staged or otherwise, and its
  one failure scenario is a transaction-level assertion failure, not a
  per-row quarantine write on any destination — the mysql-destination
  staged-write and quarantine paths were only actually proven live by
  Phase 13's end-to-end smoke (`clean-propose-smoke.ts`).
- `smoke:write` and `smoke:write:mysql-mongo` re-run clean per Step 3
  (the write path changed for every run, staged or not).

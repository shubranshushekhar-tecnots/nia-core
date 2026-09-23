# Phase 9 exit report

Covers `docs/plans/phase9.md` Parts 1-5. Full narrative and rationale:
`docs/decisions.md`'s "Phase 9 Part 1: local-workflow exposure check..." and
"Phase 9: residual-stateful-op bug fix, keyset/pagination ParamSink
hardening, pushed onFailure pre-checks — closed" entries.

## What shipped

- **Part 1 — stateful-residual bug fix.** A residual stateful op (today only
  `aggregate`) previously ran independently per fetched chunk and upserted
  each chunk's partial result, silently overwriting instead of combining
  with earlier chunks — a live silent-wrong-results bug for any residual
  aggregate spanning more than one chunk. Every op module now declares
  `residualExecution: "row-local" | "stateful"`; the chunk-scoped residual
  executor hard-errors if asked to run a stateful op on a single chunk;
  `runEtl.ts` splits residual steps at the first stateful op, runs
  row-local steps per chunk as before, and accumulates the stateful op
  across every chunk via per-group accumulators (capped,
  `RESIDUAL_GROUP_CAP`), only emitting/writing after the last chunk. Local
  dev DB exposure check: zero workflows currently trigger the pre-fix path
  (see decisions.md's dedicated entry) — real, fixable latent bug, not yet
  triggered live.
- **Part 2 — keyset cursor through `ParamSink`.** The row-keyset cursor and
  the new group-key cursor both resolve through `compileSql`'s `ParamSink`
  in the same textual-order pass as every other literal, closing the last
  call site that bypassed it (same class of mysql param-index desync risk
  as the batch-5 `ParamSink` hardening).
- **Part 3 — pushed aggregate pagination.** A pushed aggregate's output is
  now paged by group-key keyset (page size `MAX_CHUNK_ROWS`), ordered by
  the groupBy columns, checkpointed the same way Extract's own cursor is.
  The old fail-at-cap guard is removed; pagination supersedes it.
- **Part 4 — pushed `onFailure` pre-checks.** Each pushed fallible step
  (`fail`/`null`/`drop`) now runs one pre-check query before extraction:
  `fail` aborts up front on `EXISTS(failure predicate)`; `null`/`drop`
  report a `COUNT(failure predicate)` — both stay fully pushed. Resolves
  `PHASE8_EXIT.md`'s "8b-3 pushed `null`/`drop` failure counts are silent"
  risk.
- **Part 5 — consistency caveat.** Documented, not fixed, per the plan:
  pages/chunks/pre-checks are separate non-snapshotted queries against a
  live source; the same class of read-consistency gap the existing
  chunked Extract already has. No new mechanism introduced.
- **Close-out fix — numeric group-key pagination cursor.** The "numeric
  groupBy column + BINARY" open risk below (now resolved) was reproduced
  and fixed: mysql's aggregate emission selects one extra hidden column
  per group-by key — `HEX(BINARY <col>)` — and both the pagination cursor
  and the `WHERE`-side keyset comparison are now taken from that same
  byte-order expression `ORDER BY` sorts on, for every key type, instead
  of the column's own (numeric) type. Hidden cursor columns are stripped
  before residual transforms/write. Live case:
  `agreementCases.ts` tag `aggregate-pagination-numeric`.
- **Close-out fix — `coalesce` handling rule refined.** The 8b-3 "coalesce
  directly wrapping a fallible call is always handled" rule was too
  broad: `coalesce(parse_date(x, f1), parse_date(x, f2))` marked both
  calls handled, so a value matching neither format silently became
  `NULL` with no failure ever counted. Refined so a `coalesce` only
  handles its nested fallible calls when its *last* argument is itself
  non-fallible (a guaranteed non-null fallback); otherwise the coalesce
  becomes one compound fallible unit that fails when every nested call's
  own input was non-null and the coalesce's result is still `NULL`.
  `is_null`/`is_not_null` keep their original, unconditional exemption.

## Bugs found (beyond the plan's explicit scope)

1. **mysql GROUP BY/ORDER BY collation merge (found + fixed).** The
   required adversarial live case (4-way, page size 2, 2-column GROUP BY,
   param'd HAVING, a NULL group key, `"a"`/`"A"` case-differing keys)
   confirmed mysql's default collation silently merges case-differing
   string group keys. Fixed in `aggregate.ts`'s `emitSql`: every mysql
   `GROUP BY`/`ORDER BY` groupBy column is now forced `BINARY`
   unconditionally. Re-run live: all 4 arms agree (5 groups), XPASS — the
   case's `expectedDivergence` marker was removed as stale.
2. **`ANY_VALUE` missing alias (found + fixed, not in the original plan).**
   Forcing `BINARY` on GROUP BY breaks a plain `SELECT col` under this
   sandbox's `ONLY_FULL_GROUP_BY` (mysql error 1055) — fixed by wrapping
   the mysql SELECT-list groupBy columns in `ANY_VALUE(col)`. Caught by an
   existing regression test (`runPreview.test.ts`) that `ANY_VALUE(col)`
   without an alias reports the mangled expression text as the column
   name instead of the field name, which would have broken every
   downstream column-name-based row mapping. Fixed by aliasing:
   `ANY_VALUE(col) AS col`.

## Open risks

- **MySQL DECIMAL-as-string XFAIL — scope unconfirmed, may be
  connector-wide.** The `aggregate-pagination-numeric` live case declares
  an `expectedDivergence` for its DECIMAL(10,2) groupBy column: mysql2
  returns it as a JS string (`"1.50"`), while postgres/mongo/residual
  return a JS number (`1.5`). This was only confirmed for a DECIMAL
  column reached through the new hidden-cursor aggregate path — it's not
  yet checked whether plain (non-grouped, non-cursor) DECIMAL columns
  exhibit the same string-vs-number mismatch across the mysql connector
  more broadly (`SELECT`, `computed_field`, non-aggregate reads). Check
  this first thing in Phase 10, before assuming the divergence is scoped
  to aggregate pagination alone.
- **Part 5's consistency gap** (see above) — accepted v1 limitation, not a
  regression introduced by this phase.
- **Resume for a stateful residual op restarts extraction from the
  beginning** (accumulator state is in-memory, not checkpointed) —
  deferred, tracked in `TODO.md`.
- **A pushed aggregate prefix feeding a further residual stateful op**
  (chained aggregates) is not paginated inside the residual executor's own
  loop — expected vanishingly rare since pushdown normally removes the
  aggregate step from `residualSteps` entirely; tracked in `TODO.md`.

## Verification

- Typecheck: `@nia/schemas`, `@nia/worker`, `@nia/guardrails`, `@nia/web`
  — all clean.
- Unit tests: `@nia/schemas` 510/510 (20 files); `@nia/worker` 143/143 (17
  files); `@nia/guardrails` 72 passed + 1 expected-fail (73 total, 4
  files).
- Full live `ops-agreement` suite (4-way, all cases, no tag filter): 218
  cases, 0 untriaged divergences/errors (1/218 diverged + 1/218 errored,
  both the single pre-existing, unrelated date-shape `expectedDivergence`
  case — not new, not Phase-9-related).
- All 7 worker smoke scripts, all "ALL PASSED" against the real
  docker-compose sandbox: `smoke` (dispatch-smoke.ts), `smoke:aggregate`,
  `smoke:aggregate:postgres-source`, `smoke:write`,
  `smoke:write:mysql-mongo`, `smoke:mapping`, `smoke:chat` (real LLM
  gateway calls, `NIA_GATEWAY_API_KEY` present in `.env` — not skipped).
- `pnpm kill-test`: 1,000,000-row run killed mid-flight and resumed —
  destination row count, source/destination checksum, and 0 duplicate
  rows by upsert key all match. KILL TEST PASSED.
- `pnpm conformance:fixtures` (`ops-db-conformance.ts`): 22 fixtures ×
  3 dialects (filter/computed_field/drop_fields/aggregate SQL-shape
  assertions) — ALL PASSED.

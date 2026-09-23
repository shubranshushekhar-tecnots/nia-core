# Phase 13 exit report

Covers `docs/plans/phase13.md`. Full narrative and rationale:
`docs/decisions.md`'s "Phase 13: the LLM cleaning pipeline..." entry.

## What shipped

- **Golden corpus (`eval/clean/<dataset>/`).** 10 datasets (≤ 40 rows
  each), each an `input.json`/`expected.json`/`meta.json` triple,
  covering currency amounts, European decimals, percentages, mixed and
  ambiguous date formats, boolean-like tokens, missing tokens, numbers
  with units, identifier-trap columns (leading zeros, scientific-
  notation-shaped codes, phone numbers), and one fully-clean control
  dataset. All `meta.json` still `reviewed: false` pending human
  review of the expected outputs.
- **Router (`apps/worker/src/lib/clean/router.ts`).** Deterministic,
  no LLM. Per column: identifier-like skip (leading zeros, or name
  matching `id`/`zip`/`postal`/`code`/`phone`/`account`/`sku`) checked
  first and unconditionally, then missing-value (any missing token/
  blank/whitespace present) and coercion (text-declared with a partial
  parse rate, or failing examples showing currency/percent/thousands-
  separator/unit signals) independently — a column can route to both,
  neither, or one.
- **Specialists (`missingValueSpecialist.ts`, `coercionSpecialist.ts`,
  `specialistEngine.ts`).** One batched LLM call per specialist,
  parallel, temperature 0, structured JSON output, profile-only input
  (stats + capped examples, never raw rows). Missing-value never
  fills/imputes — only normalizes matched tokens to NULL. Coercion
  defaults `onFailure: "quarantine"`. Every output validated against
  the closed Expr AST + op compiler; invalid output retries once with
  the validation error, then drops that column's proposal and reports
  it if still invalid.
- **Assemble + dry-run (`assemble.ts`).** Missing-value steps ordered
  before coercion steps. Dry-runs the assembled steps against a fresh
  profiler sample via the residual evaluator; drops any coercion
  proposal with a dry-run failure rate over 50%; sets each surviving
  step's `maxFailureRate = max(2 × dry-run rate, 1%)`. Provenance
  (`{source: "specialist", specialist, planId, model}`) attached to
  every added step.
- **CleanPlan + drift (`packages/schemas/src/cleanPlan.ts`,
  `apps/worker/src/lib/etl/cleanPlanDrift.ts`, migration
  `0024_clean_plans.sql`).** Applying a cleaning `PlanDiff` records a
  `clean_plans` row binding workflow+node to the applied steps hash,
  schema hash, profile hash, and pinned op-catalog/adapter version
  constants. At run start, both hashes are recomputed with the profile
  cache bypassed; a mismatch on either refuses the run with a message
  naming which binding changed. A manual edit to a bound step unbinds
  it (node becomes plain-manual). LLM prompts/outputs recorded to the
  audit log.
- **API + queue (`apps/api/src/routes/workflows.ts`,
  `apps/api/src/lib/cleanQueue.ts`, `apps/api/src/services/
  cleanPropose.ts`).** `POST /:id/clean/propose` mirrors the existing
  `plan_propose` mapping/profile queue shape (BullMQ producer, worker
  consumer).
- **UI (`apps/web/src/components/canvas/TransformEditor.tsx`).** A
  "Propose cleaning" action on a source node's pipeline runs profile →
  route → propose → assemble and shows the proposal as a ghost preview
  (per-column route reason, rationale, onFailure, dry-run before/after,
  failure counts; skipped identifier-like columns listed with their
  reason). Apply goes through the existing revertible diff-apply path.
  A manual edit to a bound step unbinds it.
- **Tests (Step 9).** Router unit tests (one per rule, including the
  identifier-like skip); an invalid-specialist-output retry-then-drop
  unit test; a CleanPlan binding-mismatch unit test (refuses the run,
  names the binding); and one end-to-end smoke test
  (`apps/worker/scripts/clean-propose-smoke.ts`, `pnpm --filter
  @nia/worker smoke:clean`) driving a messy sandbox Postgres source
  through propose → apply → a real staged MySQL run, asserting
  destination values and quarantine count.

## Eval report summary

`pnpm --filter @nia/worker eval:clean`, single run per dataset per the
governing instruction's explicit override of the plan's "twice"
default (see `docs/decisions.md`). Full output saved to
`apps/worker/eval-reports/clean-eval-2026-09-22T11-42-01.log`.

- **6/10 datasets passed.** 0 hard failures — no `mustNotChange`
  column was ever touched by any proposal, on any dataset.
- **4 failures, all single-completion LLM behavior, not code
  defects**, falling into three categories (full detail in
  `docs/decisions.md`):
  1. Token-omission variance: a manually-enumerated token/value
     equality chain (no closed "one of these N literals" vocabulary
     function exists) drops one token from an otherwise-correct list.
     Hit `booleans-mixed-tokens` (dropped `"N"`) and
     `missing-tokens-various` (dropped `"?"`) in this run.
  2. No-coalesce mixed-date-format limitation: `dates-mixed-formats`
     — the coercion specialist self-declined entirely rather than
     building a `coalesce(parse_date(...), parse_date(...), ...)`
     fallback chain across the column's several individually-
     unambiguous-but-differently-formatted rows.
  3. Self-flagged mixed-unit conservatism: `numbers-with-units` — the
     specialist correctly refused to invent a unit conversion for a
     genuinely heterogeneous (kg/lbs/m/ml) column; safe behavior,
     counted as a miss against `expected.json`'s ground truth.
- All 10 datasets remain provisional (`meta.json` `reviewed: false`);
  results should be re-read once a human confirms expected outputs.

## Bugs found

**MySQL quarantine writes were silently broken for every real run**,
found via Step 9's e2e smoke test (the first smoke script ever to
drive a failing/quarantined row through a MySQL destination).
`apps/worker/src/lib/etl/stagedWrite.ts`'s `truncateSourceRow()`
returned a plain JS object instead of a JSON string for the
`source_row` quarantine column. This worked by accident against
Postgres destinations (`pg` auto-serializes objects into `jsonb`
params) but made `mysql2` stringify the object as the literal string
`"[object Object]"`, which MySQL's JSON-column parser rejected —
failing the entire quarantine insert (and thus the whole write batch)
with `Invalid JSON text: "Invalid value." at position 1`. Fixed by
always `JSON.stringify`-ing before returning, matching the string
contract both connectors' pre-existing unit tests already assumed.

## Deviations from the plan, with reasons

- **Step 8 run count:** one run per dataset instead of two, per the
  governing instruction's explicit "keep tests lean" override.
  `run-clean-eval.ts` reports "n/a (single run per Step 8 override)"
  instead of a two-run match rate.
- **Step 6 addition (per the governing instruction, not the original
  plan text):** confirmed the `nia` schema grants no `USAGE` to
  `anon`/`authenticated`, and that RLS is enabled on `nia_quarantine`
  as well as the staging tables. Neither guard existed yet — both
  added to connector-supabase's `/preflight`
  (`nia-schema-no-anon-authenticated-usage`,
  `nia-schema-rls-enabled` checks in `services/connector-supabase/src/
  index.ts`), each returning the exact `REVOKE`/`ALTER TABLE ...
  ENABLE ROW LEVEL SECURITY` an operator would need to run on failure.
  `anon`/`authenticated` only exist on a real Supabase-hosted Postgres
  (the sandbox has neither), so 0 matching roles is treated as pass,
  not skip.
- No other deviations. Steps 2–7 and 9–10 match the plan as written.

## Open risks

- **All 4 eval misses are open, not fixed** — they're documented
  behavioral limits of the current specialist prompt contract (token-
  enumeration reconstruction has no closed vocabulary primitive; no
  reliable multi-format date coalesce construction), not this phase's
  scope to close. Candidates for a future phase: a dedicated
  `is_missing_token(field)`/`in(field, [...])` op that specialists can
  emit instead of manually reconstructing an equality chain every
  call, and/or a coercion-specialist prompt example demonstrating a
  multi-format `coalesce(parse_date(...), ...)` chain.
- **Golden corpus is entirely unreviewed** (`reviewed: false` on all
  10 `meta.json` files) — expected outputs are my own draft, not yet
  human-confirmed ground truth, per the plan's own instruction not to
  treat them as such.
- **CleanPlan drift refusal has unit coverage but no live-run
  exercise** — the binding-mismatch behavior is proven at the unit
  level (Step 9) and never yet driven through a real schema-drift or
  profile-drift scenario end-to-end against a live sandbox DB.
- **The two new `/preflight` guards (anon/authenticated USAGE,
  `nia` schema RLS) have no dedicated unit test** — `/preflight` as a
  whole has never had unit coverage (only exercised indirectly via
  the `presmoke:*`/`smoke:clean` scripts against a real sandbox DB),
  so this isn't a Phase-13-introduced regression, but it means these
  two specific checks are only proven by manual/smoke-script runs
  against the sandbox, never by an isolated unit test.

# Route 1 — smallest safe change to run a dialect-less ("Local database (via agent)") source

Scope: `sqlserver-agent` (manifest name "Local database (via agent)",
`packages/schemas/src/connectors/sqlserver_agent.ts:30`) returns rows via a
structured read (no SQL text). `manifestDialect()` returns `null` for it
today, and `apps/worker/src/lib/etl/runEtl.ts:769` hard-fails any source
with no dialect. This extends `docs/plans/route1-design.md` with the
current, narrower answer — most of that doc's §1/§2 plumbing (the
`StructuredQueryPayload` wire type, the `structured` guardrail validator,
`buildEtlReadQuery`'s `"structured"` branch) **already shipped**; only
`runEtl.ts`'s own gate was never wired. `apps/worker/src/lib/preview/
runPreview.ts:267-271` already solved this exact problem for the preview
path — the pattern below is a direct copy of it, not a new design.

**Key decision, differing from route1-design.md §1's row on `pushdown.ts`:**
do **not** widen `SourceDialect` or `manifestDialect()`'s return type.
`SourceDialect` backs two exhaustive `Record<SourceDialect, ...>` tables —
`packages/schemas/src/ops/types.ts:39` (`FN_PUSHABILITY`, ~40+ `CallFn`
rows) and `packages/schemas/src/niaAdapters.ts:240` (`DIALECT_ADAPTERS`).
Adding `"structured"` to the union would force a new key onto every one of
those rows (dozens of unrelated lines, in a package shared by every
connector) for a dialect that can never be pushed to. `runPreview.ts`
already rejected that approach in favor of a **local special-case at each
call site** — `manifestDialect()` is left untouched; callers that know
about `"structured"` compute it themselves and guard every place they pass
`dialect` onward to a function that doesn't understand it.

---

## 1. Files and exact lines

### apps/worker/src/lib/etl/runEtl.ts (the only package that needs changes)

| Line(s) | Current | Change |
|---|---|---|
| 768 | `const dialect = manifestDialect(source.manifestId);` | `const dialect: SourceDialect \| "structured" \| null = source.manifestId === "sqlserver-agent" ? "structured" : manifestDialect(source.manifestId);` — exact copy of `runPreview.ts:270-271`. |
| 769-771 | `if (!dialect) return fail(...)` | Unchanged — `"structured"` is truthy, so this gate now passes for agent sources exactly as it does for mysql/postgres/mongo. |
| 773-776 (`destDialect`) | `manifestDialect(dest.manifestId)` | **Unchanged.** Destinations never get the special-case — a destination still must be a real SQL/Mongo dialect (writes need dialect-native type mapping). An agent source may only ever be paired with an existing destination kind. |
| 940, 947 | `if (transforms.length === 1) { ... compilePushdown(dialect, transformConfig) ... } else if (transforms.length > 1) { ... }` | Guard both branches: `if (dialect !== "structured" && transforms.length === 1) { ...compilePushdown(dialect, ...)... } else if (dialect === "structured" \|\| transforms.length > 1) { /* push every step into residualSteps unconditionally, same as today's >1-node branch */ }`. `compilePushdown`'s own signature (`SourceDialect \| null`) is untouched; TS narrows `dialect` to `SourceDialect` inside the `dialect !== "structured"` branch. |
| 998 | `if (job.cursor === null) {` (gates the `compileFailurePreChecks`/`buildFailurePreCheckQuery` pre-check loop) | `if (job.cursor === null && dialect !== "structured") {` — structured sources have no aggregate/COUNT concept to pre-check (route1-design.md §1 row 2); skip the block entirely rather than teaching `compileFailurePreChecks`/`buildFailurePreCheckQuery` a third dialect. |
| 1077-1078 | `if (cursorCondition \|\| groupKeyCursor) { dialectQuery = compilePushdown(dialect, cursorPushdownConfig, cursorCondition, groupKeyCursor).dialectQuery; }` | `if (dialect !== "structured" && (cursorCondition \|\| groupKeyCursor)) { ... }` — same narrowing as the line-940 guard; for a structured source `dialectQuery` simply stays `null` from its initial declaration (line 937), which is correct (never any pushed fragment to recompile). |
| 328 (`runStatefulResidual`'s `args` type) | `dialect: SourceDialect;` | `dialect: SourceDialect \| "structured";` — the stateful-residual path (aggregate-after-non-SQL-source etc.) must also accept the widened value the caller now passes in. |
| ~414 (inside `runStatefulResidual`) | `const dialectQuery = compilePushdown(dialect, cursorPushdownConfig, cursorCondition).dialectQuery;` | `const dialectQuery = dialect === "structured" ? null : compilePushdown(dialect, cursorPushdownConfig, cursorCondition).dialectQuery;` |

Lines 390, 413, 415, 967, 1053, 1068, 1080 (`dialect === "mongo" ? ... : ...`,
`buildEtlReadQuery(dialect, ...)`, the primary-key gate) need **no edits** —
every one of those is either a plain `=== "mongo"` literal check (still
compiles and behaves correctly with `dialect = "structured"`, which simply
falls into the "else" arm already used for mysql/postgres) or a call to
`buildEtlReadQuery`, whose signature is already `SourceDialect | "structured"`
(`apps/worker/src/lib/etl/queryBuilder.ts:57`) and already has a working
`"structured"` branch (`queryBuilder.ts:64-81`) — written ahead of this gap
being closed, currently dead code because nothing upstream ever produces
`dialect === "structured"` yet.

### No other package needs changes — already shipped, ahead of this gap:
- `packages/schemas/src/contract.ts:172-183` — `StructuredQueryPayload` is
  already a member of the `QueryPayload` discriminated union.
- `packages/guardrails/src/registry.ts:20` + `structured.ts` — `"sqlserver-agent"`
  is already registered to `validateStructuredQuery`.
- `apps/worker/src/lib/etl/queryBuilder.ts` — `buildEtlReadQuery`'s
  `"structured"` branch (lines 64-81) already exists and is already
  exercised by `queryBuilder.test.ts`'s "structured (agent-backed) sources"
  describe block. `buildFailurePreCheckQuery` needs **no** change — the
  runEtl.ts guard at line 998 means it is simply never called for a
  structured source; TS narrows `dialect` away from `"structured"` before
  that loop, so the call site still type-checks against its existing
  `dialect: SourceDialect` parameter.
- `packages/schemas/src/pushdown.ts` (`manifestDialect`, `compilePushdown`,
  `compileFailurePreChecks`) — deliberately untouched (see "Key decision"
  above).

---

## 2. Behavior risk to existing sources (mysql/postgres/supabase/mongodb) + tests that would catch a mistake

| Change | Can it alter existing-source behavior? | Covering tests |
|---|---|---|
| Line 768 ternary | Only if `source.manifestId === "sqlserver-agent"` is mistyped/mis-ordered; for any other manifestId the expression reduces to the exact original `manifestDialect(...)` call — same risk profile as before. | `apps/worker/src/lib/etl/runEtl.test.ts` (dialect-selection/dispatch assertions per connector); `queryBuilder.test.ts`. |
| Lines 940/947 guard rewrite | Real risk: the `else if` condition changes from `transforms.length > 1` to `dialect === "structured" || transforms.length > 1`. A mistake here (e.g. inverted `!==`) would push `dialect` into `compilePushdown` for a real SQL/Mongo source too, or skip pushdown for a real source with exactly one transform node — a correctness regression (loses pushdown, or crashes on a type it can't handle). | `runEtl.test.ts`'s pushdown/residual-split assertions for mysql/postgres/mongo; `packages/schemas/src/pushdown.test.ts` (compilePushdown behavior per dialect). |
| Line 998 guard | Low risk — adds an `&&`, doesn't touch the existing `job.cursor === null` condition for any other dialect. | `runEtl.test.ts`'s failure-pre-check tests (if any target mysql/postgres aggregate `having` fail policy). |
| Lines 1077-1078 guard | Same shape/risk as 940/947 — a flipped condition could silently stop recompiling the cursor-folded `dialectQuery` for a real SQL source on chunk 2+, breaking pagination. | `runEtl.test.ts`'s multi-chunk/keyset-pagination tests; `apps/worker` integration tests that run a multi-chunk MySQL/Postgres ETL. |
| Line 328 + ~414 (`runStatefulResidual`) | Only reachable when a stateful residual op (aggregate) runs against a non-pushed source; widening the param type is additive (union gets one more member) and the new `dialect === "structured"` branch is new code, so existing mysql/postgres/mongo call paths are unchanged as long as the ternary isn't reordered. | Any existing aggregate-residual test in `runEtl.test.ts`/`apps/worker`'s integration suite exercising mysql/postgres/mongo with a stateful aggregate step. |

Overall: every change is a **guard added around an existing call**, never a
rewrite of the call itself — the mechanical risk is an inverted/mistyped
boolean condition, not a semantic change to how mysql/postgres/mongo
dialects compile or execute.

---

## 3. What a user loses vs. a SQL source

- No filtered/limited pushdown at all — every `filter`/`computed_field`/
  `aggregate` step in the transform graph runs in the worker, after a full
  unfiltered page comes back (`compilePushdown`/`splitPushable` never run
  for `"structured"`; `buildEtlReadQuery`'s structured branch always sends
  `filter: []`, `columns: []`).
- No `FailurePreCheck` (`onFailure: "fail"` with a count-based abort
  message) — skipped outright for this dialect (line 998 guard); a failing
  row is only caught after a full chunk fetch, residually.
- No aggregate pushdown / `GROUP BY`-keyset pagination — `isAggregatePushdown`
  can never be true for a structured source (no `dialectQuery.isAggregate`
  is ever produced), so an aggregate transform node always runs as the
  worker's stateful residual accumulator instead of a `GROUP BY` at the
  source.
- Slower, network-bound reads generally: each chunk is one agent-bridge
  `/execute` round trip waiting on the agent's own check-in loop
  (`docs/plans/route1-design.md` §5 estimates ~1-3s/chunk, ~100-500 rows/sec
  realistic vs. a direct DB connection's single-digit-ms query time).
- Composite-key and no-primary-key tables are unsupported (same
  `entity.primaryKey` gate every connector already has — not a new
  limitation, just inherited unchanged).

---

## 4. Lines changed in apps/worker

**~9 lines changed, 0 new files, 1 file touched** (`apps/worker/src/lib/etl/runEtl.ts`):
line 768 (1), lines 940/947 (2), line 998 (1), lines 1077-1078 (1-2), line 328
(1), line ~414 (1) — plus trivial surrounding punctuation from splitting an
`if`/`else if` condition. No changes anywhere else in apps/worker (`queryBuilder.ts`,
`dispatch.ts`, `resolveConnection.ts`, `connectorClient.ts` are all already
correct for this case, per route1-design.md §1's own "dispatch.ts/
resolveConnection.ts: None" row, confirmed still true).

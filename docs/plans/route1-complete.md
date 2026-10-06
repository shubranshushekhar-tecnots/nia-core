# Route 1 — complete dialect/native-type dependency trace (structured source → Postgres/Supabase destination)

Scope: every place a run of a `sqlserver-agent` ("Local database (via agent)")
source into a SQL destination touches source dialect or source native types,
traced end-to-end through checks → run start → reading → transforms →
destination contract → create/alter destination table → type conversion →
writing → quarantine → checkpoints → profiling/preview. `docs/plans/
route1-dialect.md`'s claim that `runEtl.ts` is "the only package that needs
changes" is **incomplete** — it covers reading/transforms but not the
destination-contract chain or the two profiling entry points below.

## 1. Per-stage trace

### Checks
No dependency. `apps/worker/src/lib/checks/runWorkflowChecks.ts` and
`packages/schemas/src/checks.ts` never reference dialect or native types.

### Run start / reading / transforms
| # | File:line | What it needs | Smallest safe change | apps/worker? | Catching tests |
|---|---|---|---|---|---|
| 1 | `apps/worker/src/lib/etl/runEtl.ts:768` | `dialect` variable used downstream by pushdown/pre-check/cursor logic | `const dialect: SourceDialect \| "structured" \| null = source.manifestId === "sqlserver-agent" ? "structured" : manifestDialect(source.manifestId);` | yes | `runEtl.test.ts` |
| 2 | `runEtl.ts:940,947` | pushdown compilation only for a real dialect | guard `dialect !== "structured" && transforms.length === 1` / `else if (dialect === "structured" \|\| transforms.length > 1)` | yes | `runEtl.test.ts`, `pushdown.test.ts` |
| 3 | `runEtl.ts:998` | failure pre-check loop needs a real dialect's COUNT query | `if (job.cursor === null && dialect !== "structured")` | yes | `runEtl.test.ts` (pre-check cases) |
| 4 | `runEtl.ts:1077-1078` | cursor-folded dialectQuery recompile | `if (dialect !== "structured" && (cursorCondition \|\| groupKeyCursor))` | yes | `runEtl.test.ts` (multi-chunk pagination) |
| 5 | `runEtl.ts:328` (`runStatefulResidual` param) | widened param to accept the new value passed in | `dialect: SourceDialect \| "structured"` | yes | `runEtl.test.ts` (aggregate-residual cases) |
| 6 | `runEtl.ts:~414` | no pushdown recompile possible for structured | `const dialectQuery = dialect === "structured" ? null : compilePushdown(...)` | yes | `runEtl.test.ts` |
| 7 | `apps/worker/src/lib/etl/queryBuilder.ts:57,64-81` | structured-query page shape | already shipped, dead code until #1 lands | yes | `queryBuilder.test.ts` ("structured (agent-backed) sources" block) |
| 8 | `apps/worker/src/lib/profile/sampleEntity.ts` (whole file) | structured sampling for profiling | already shipped | yes | none dedicated — exercised transitively via `profileEntity`/`cleanPlanDrift` tests, of which none currently exist (see #11, #12) |
| 9 | `packages/guardrails/src/registry.ts:20` + `structured.ts` | validator registration for `sqlserver-agent` | already shipped (`validateStructuredQuery`) | no (packages/guardrails) | `validator.test.ts` |

### Destination contract (the real blocker)
| # | File:line | What it needs | Smallest safe change | apps/worker? | Catching tests |
|---|---|---|---|---|---|
| 10 | `apps/worker/src/lib/etl/ensureDestination.ts` — `buildRuntimeContract(destDialect, sourceEntity, sourceDialect, ...)` and `ensureDestination(...)`'s matching param | both functions declare `sourceDialect: SourceDialect`, then pass it straight into `schemaFromIntrospection`, which has no `"structured"` branch — this is the actual compile-time blocker found in the prior session (`tsc` errors at the old line 796/851) | widen both functions' `sourceDialect` param to `SourceDialect \| "structured"` (2 lines) — `destDialect` is untouched, it's always a real dialect | yes | none existing today; would need a new case in whatever test file exercises `ensureDestination`/`buildRuntimeContract` (none found under `apps/worker/src/lib/etl/*.test.ts` by name — closest is `runEtl.test.ts`'s destination-contract assertions, which only exercise mysql/postgres/mongo sources currently) |
| 11 | `packages/schemas/src/niaAdapters.ts` — `schemaFromIntrospection(entity, dialect: SourceDialect)` → `getDialectAdapter(dialect)` → `DIALECT_ADAPTERS[dialect]` (`Record<SourceDialect, DialectAdapter>`, only `mysql`/`postgres`/`mongo`) | a way to turn the agent's 5 `ExtractType` strings into a `NiaType` + `Fidelity`, without widening `SourceDialect` (would force a new key onto every row of `FN_PUSHABILITY` in `packages/schemas/src/ops/types.ts:39` and `DIALECT_ADAPTERS` itself — dozens of unrelated lines in a package shared by every connector) | widen `schemaFromIntrospection`'s own `dialect` param to `SourceDialect \| "structured"`; add a local `if (dialect === "structured") return { schema: structuredToNiaType(entity), fidelity: ... }` branch *inside* `schemaFromIntrospection`, bypassing `getDialectAdapter`/`DIALECT_ADAPTERS` entirely — see §2 for the adapter itself | no (packages/schemas) | `niaAdapters.test.ts` (existing file, currently only covers mysql/postgres/mongo `toCases` tables by dialect — would need a new `describe("structured")` block, doesn't exist yet) |
| 12 | `packages/schemas/src/destinationContract.ts` — `buildDestinationContract`'s `dialect` field | this is always the **destination** dialect (`getDialectAdapter(input.dialect)` for `fromNiaType`, and `destDialect === "mongo" ? "collection" : "table"`) | **no change** — confirmed by reading the whole file; nothing here keys off the source side | n/a | `destinationContract.test.ts` |

### Creating/altering the destination table
No dependency beyond #12 above — `compareContractToExisting`/`buildAlterStatement` are keyed only on `destDialect`, always a real SQL dialect in this route (an agent source may only pair with a real destination).

### Type conversion
No separate code path — once #10/#11 land, `contract.rawSourceSchema`/`contract.niaType` carry correct values into `packages/schemas/src/conformance.ts`'s casting logic, which has no dialect reference of its own (confirmed by grep). **Real residual risk, not a code gate**: SQL Server's `castToText` logic (`packages/extract/src/mssql/buildSelectSql.ts`) makes the agent's single `ExtractType: "number"` arrive as a JS **string** for `decimal/numeric/money/smallmoney/bigint` columns but as a native JS **number** for `int/smallint/tinyint/float/real` — one `ExtractType` value, two different runtime shapes. The type adapter (§2) can only map the declared type string, not the runtime shape; this is a known, accepted fidelity gap worth stating explicitly to users (§3), not something a 1-line fix closes.

### Writing / Quarantine / Checkpoints
No dependency. `apps/worker/src/lib/etl/stagedWrite.ts` and `apps/worker/src/lib/etl/workflowRuns.ts` were grepped for dialect/native-type references — none found; both operate purely on the already-resolved contract/conformance output.

### Profiling and preview
| # | File:line | What it needs | Smallest safe change | apps/worker? | Catching tests |
|---|---|---|---|---|---|
| 13 | `apps/worker/src/lib/profile/profileEntity.ts:43-45` | `manifestDialect(connection.connectorId)` gate that throws for `sqlserver-agent` | `const dialect: SourceDialect \| "structured" \| null = connection.connectorId === "sqlserver-agent" ? "structured" : manifestDialect(connection.connectorId);` then pass through to `sampleEntity` unchanged (already handles `"structured"`) | yes | **none** — no `profileEntity.test.ts` exists |
| 14 | `apps/worker/src/lib/etl/cleanPlanDrift.ts` — `checkCleanPlanDrift()` | calls `profileEntity()` directly for a bound CleanPlan node, inside `runEtl.ts`'s per-transform loop | no separate change — fixed transitively by #13 | yes | `cleanPlanDrift.test.ts` (exists, but only exercises mysql/postgres sources today — would need a new case) |
| 15 | `apps/worker/src/lib/clean/proposeCleaning.ts:108-111` | its own independent `manifestDialect` gate (does **not** reuse `profileEntity.ts`), feeding `sampleEntity(dialect, ...)` directly | same ternary pattern as #13, applied locally | yes | **none** — no `proposeCleaning.test.ts` exists |
| 16 | `apps/worker/src/lib/preview/runPreview.ts:267-271` | structured-dialect handling for live preview | already shipped — this is the pattern #1/#13/#15 copy | yes | preview test suite (exists, exercises mysql/postgres/mongo; would benefit from a structured case but isn't a gate that needs fixing) |

### Adjacent, out of scope for this route (flagged, not required)
- `apps/web/src/components/canvas/MappingEditor.tsx:361` — client-side preview of the destination contract in the Mapping Editor UI. Already degrades gracefully: guards `if (... || !sourceDialect || !destDialect || ...) return undefined;`, so a structured source today just shows no type/fidelity preview, no crash. Fixing it (mirroring #11's widening) is optional UI polish, not required for a run to succeed. Not in apps/worker.
- `apps/worker/src/lib/plan/probeCardinality.ts` + `validateFeasibility.ts` + `listConnections.ts` — the separate Chat/"plan" feature's own dialect lookup (`listConnections.ts`'s `manifestDialect`) returns `null` for a structured connection, so `probeCardinality` always returns "unmeasured" (-1) and that feature refuses to plan over such a source today. Independent of the ETL run path; out of scope here.

## 2. Proposed type adapter

Add a standalone function in `packages/schemas/src/niaAdapters.ts`, **not** entered into `DIALECT_ADAPTERS` and **not** reachable through `getDialectAdapter` — called only from the new `dialect === "structured"` branch inside `schemaFromIntrospection` (see #11). This keeps `SourceDialect`, `DIALECT_ADAPTERS`, and `FN_PUSHABILITY` (`packages/schemas/src/ops/types.ts:39`) completely untouched — zero new rows for any other dialect's pushdown table.

```ts
function structuredToNiaType(extractType: string): { type: NiaType; fidelity: Fidelity } { ... }
```

| ExtractType | NiaType | Fidelity | Why |
|---|---|---|---|
| `text` | `{ kind: "string" }` | lossless | direct mapping |
| `number` | `{ kind: "decimal" }` | lossy | `ExtractType` collapses int/decimal/float/money subtypes into one bucket; exact subtype and precision/scale are lost at this layer, and (see §1 "Type conversion") the runtime JS value is sometimes a string, sometimes a native number, depending on the underlying SQL Server type |
| `date` | `{ kind: "date" }` | lossless | direct mapping |
| `datetime` | `{ kind: "timestamp", tz: "naive" }` | lossy | SQL Server's `datetime`/`datetime2`/`datetimeoffset` all collapse to one `ExtractType`; timezone/offset information is not preserved at this layer |
| `boolean` | `{ kind: "boolean" }` | lossless | direct mapping |

Precedent for the lossy collapse already exists in `apps/agent/src/link/taskRunner.ts`'s `EXTRACT_TYPE_TO_WIRE_COLUMN_TYPE` table (a different wire protocol), which does the same `datetime → date` fold.

## 3. Files to change, with line counts

**apps/worker (4 files, ~17 lines):**
- `apps/worker/src/lib/etl/runEtl.ts` — ~9 lines (items #1-6)
- `apps/worker/src/lib/etl/ensureDestination.ts` — ~2 lines (item #10)
- `apps/worker/src/lib/profile/profileEntity.ts` — ~3 lines (item #13)
- `apps/worker/src/lib/clean/proposeCleaning.ts` — ~3 lines (item #15)

**Everything else (1 file required, ~16-18 lines; 1 file optional, 0 required):**
- `packages/schemas/src/niaAdapters.ts` — ~16-18 lines (new `structuredToNiaType()` + widened `schemaFromIntrospection` signature + new branch) — item #11
- *Optional, deferred*: `apps/web/src/components/canvas/MappingEditor.tsx` — 0 lines required for v1 (degrades gracefully today)

No changes needed anywhere in `queryBuilder.ts`, `sampleEntity.ts`, `runPreview.ts`, `destinationContract.ts`, `conformance.ts`, `stagedWrite.ts`, `workflowRuns.ts`, `connectorClient.ts`, `resolveConnection.ts`, or `packages/guardrails` — all already correct or unaffected.

## 4. What a user can and cannot do in v1

**Can:**
- Run a full ETL job from a `sqlserver-agent` source into a Postgres/Supabase destination: create/alter the table, convert the 5 simple column types, write rows, quarantine bad rows, checkpoint/resume.
- Profile and clean-plan-propose a structured entity's columns (once #13/#15 land), with head/tail keyset sampling.
- Preview a structured source live before running (already shipped).

**Cannot (v1 limitations, inherited or new):**
- No filtered/limited pushdown — every filter/computed_field/aggregate transform step runs residually in the worker after a full unfiltered page.
- No failure pre-check (count-based `onFailure: "fail"` abort) — only caught residually after a chunk fetch.
- No aggregate pushdown / GROUP BY-keyset pagination.
- Composite-key and no-primary-key tables unsupported (same gate every connector has).
- No fidelity disambiguation within the "number" bucket — a `decimal(18,4)` and a `bigint` column both report `NiaType: decimal`, lossy, with no precision/scale carried through.
- No live type/fidelity preview in the web Mapping Editor UI (optional item above, left unfixed).
- Slower throughput generally — each chunk is one agent-bridge round trip (~1-3s/chunk per route1-design.md's own estimate) vs. a direct DB connection.

## 5. Honest estimate of remaining hidden dependencies

**Some, not none, bounded.** This trace covered every call site found via repo-wide greps for `manifestDialect(`, `SourceDialect`, `getDialectAdapter(`, and `schemaFromIntrospection(` across `apps/worker`, `apps/web`, `apps/agent`, `packages/schemas`, and `packages/guardrails` — 16 numbered places plus 2 explicitly out-of-scope ones, all read in full. Known unknowns:
- **Test coverage gaps, not code gaps**: no `profileEntity.test.ts` or `proposeCleaning.test.ts` exists today, so a mistake in items #13/#15 would not be caught by any existing test — a new test would need to be written alongside the fix, not after.
- **The runtime-value-shape risk in §1's "Type conversion" section is real and not closeable by a type-adapter alone** — it's a property of how the agent casts SQL Server types to JS, not a gap in the mapping table.
- **Not fully verified**: no exhaustive search was done inside `apps/api` (the HTTP layer that triggers these jobs) for a similar `manifestDialect`-based gate on the job-submission path (e.g. a "can this source run a profile job" pre-flight check before enqueueing) — `apps/api` was out of this trace's grep scope since the user's instruction scoped the trace to the worker's run pipeline specifically. This is the one area where an additional, as-yet-unfound gate could plausibly exist.

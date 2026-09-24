# TODO

- ~~Chore: visual-baseline pixel-diffs (`/login`, `/signup`,
  `command-bar-thread-open-1440`, plus `command-bar-resting-1440` and
  `checks-dock-logs-populated-1440`, discovered during the same
  investigation)~~ — **CLOSED, all 5 root-caused and fixed** (Phase 5
  Session 5 exit-review close-out, `PHASE5_EXIT.md` §7.1). Four distinct
  causes, none of them real app drift: (1) Next dev-mode's build-activity
  pill (`<nextjs-portal>`) popping in/out with compile state, hidden via
  `display: none` before every screenshot; (2) Playwright's screenshot
  `mask` sizing its covering rectangle from the masked element's live
  bounding box, so content-hugging-width elements (answer prose, SQL
  `<pre>`) shifted the mask edges with real LLM/SQL output length — fixed
  with a fixed-width CSS pin before the screenshot (same pattern as the
  file's existing `heightPin`), not a bigger tolerance (raising
  `maxDiffPixels` alone was tried and proven not to converge — unbounded
  variance, not fixed noise); (3) a separate, small, *bounded* react-flow
  selection-outline rendering jitter, given a modest fixed `maxDiffPixels`
  headroom since it is fixed-magnitude, unlike (2); (4) the SQL panel
  bleeding through a translucent dock overlay in one screenshot that
  wasn't masking it — added to that screenshot's existing `mask` array.
  Verified via repeated isolated reruns (5/5, 3/3, 2/2 clean) and a final
  clean full-suite run (43 passed, 0 failed, 1 skipped).
  **Update:** a later re-verification pass found 3 more `canvas.spec.ts`
  failures this "43/0/1" number didn't cover (same `nextjs-portal` cause,
  1 baseline; a shared-fixture node-pollution bug, 2 tests) — fixed, and
  since re-confirmed in one clean full-suite run along with 4 further
  Phase 6 Block 0-era bugs found and fixed the same way (43 passed, 1
  failed [pre-existing live-service flake, not this suite], 1 skipped,
  0 did not run). See `PHASE5_EXIT.md` §7.3 / §8.6 — closed.
- ~~Chat feature requires an organization — allow individual/personal-workspace
  users~~ — **reconciled and closed with artifacts** (chat.spec.ts 10/1/0,
  chat-smoke exit 0, user-keyed Redis keys captured live). See
  `docs/decisions.md` for the standing rule on what counts as a proven test
  run, and commit `01436a0` for the code + coverage.
- Canvas multi-node selection (shift-click/rubber-band) — not built;
  single-select + @-pins covers chat scope. Revisit for bulk canvas ops
  and Phase 7 ghost-plan selection.
- AI-suggested charts for the destination preview (Phase 5 Session 5,
  Block 1) — not built. Preview currently renders a table plus one
  hand-rolled CSS bar chart for the single "trivially derivable" shape
  (one numeric column + one text label column, see `PreviewTable.tsx`'s
  `AutoChart`). Full AI-suggested charting (LLM picks chart type/columns
  from arbitrary preview result shapes) is deferred; no chart library is
  in the repo yet either (checked `apps/web/package.json`), so this also
  needs a library decision when picked up.
- ~~**Compiler completeness (Phase 6 Block-0 prerequisite)**: explicit
  source entity/table selection, `compilePushdown()`'s FROM gap, and
  multi-transform pushdown chaining~~ — **entity-selection gap CLOSED**
  (commit `af00263`, Phase 6 Block 0): `SourceDestConfig` now persists an
  optional `EntityRef`, picked explicitly via a `NodeDrawer` table picker;
  `entityResolution.ts`'s `findPersistedEntity`/`fieldNamesForSource`
  resolve against it with fallback to the old flat-union inference when
  unset or stale (renamed/dropped upstream) — backward compatible with
  pre-Block-0 graphs. `checkMappings`, `proposeMapping`, and
  `runPreview`'s `buildPreviewQuery` all migrated onto it; `checkConfig`
  gains a non-blocking warn nudging an explicit pick when absent.
  `compilePushdown()`'s FROM gap and multi-transform chaining remain
  intentionally un-addressed, by design, not oversight — pushdown stays
  fragment-only (doc-clarified in the same commit) and multi-transform
  still degrades to residual — both explicit Phase 5 Session 5 decisions,
  not gaps to revisit. See `PHASE5_SESSION_NOTES.md`'s Session 5 Block 1
  entry and `af00263`'s commit message for the full writeup.
- **Decision (Phase 6 Block 1 ledger item 1a-1):** `checkConfig`'s
  unset-entity result (`checks.ts`) is a non-blocking `warn` today (Block 0,
  `af00263`) — deliberately, so pre-Block-0 graphs don't flip red the
  instant the check shipped. That `warn` becomes a **hard `fail` at the
  run-gate** once the ETL runner exists: the runner has no flat-union
  fallback to fall back to the way preview/mappings do (`entityResolution.ts`'s
  header comment — "the ETL runner cannot infer what to read the way this
  preview-only bridge does"), so an unset source entity must block Run, not
  just nudge the drawer. This is a decision to implement in Phase 6 Block 4's
  run-gating work (the `checks` requested set the Run button already
  evaluates), not a code change yet — recorded here so Block 4 doesn't
  relitigate it. **Done, Block 3.5:** `runEtl.ts`/`startWorkflowRun`
  hard-reject an unset entity at run start; `checks.ts` stays `warn`
  deliberately (see `docs/decisions.md`'s Block 3.5 entry).
- **User-authorized fast mode (2026-09-18):** the full kill test (1M
  rows × 2 runs), the grant/run/status Playwright E2E, a live probe
  battery, and an isolation measurement pass across the new
  mysql/mongodb write paths were DEFERRED to a named verification
  session before PHASE6_EXIT, in favor of shipping Block 5 (write-path
  generalization) same-day. A reduced mechanism-only kill test ran in
  the full test's place — see `docs/decisions.md`'s matching entry for
  the full writeup and exactly what's still owed.
- **Phase 6 Block 6 (aggregate transform) ledger:**
  - **Sort/Limit transform kind doesn't exist** — top-N-per-group (e.g.
    "top 3 earners per cohort") is inexpressible until it does. Parked
    as a v1.1 candidate, not part of the v1 aggregate vocabulary shipped
    this block.
  - **`%_of_total` stays composition, not a first-class fn — and ruling 1
    found a real gap, not just a style preference.** A literal broadcast
    %-of-total (every row divided by one whole-table total, same grain
    in and out) is **not expressible** via this transform chain — there's
    no window/join primitive, and chaining can only change or collapse
    grain, never broadcast a coarser total back onto finer rows. What IS
    proven (`pushdown.test.ts`'s ruling-1 case): (a) a single Aggregate
    step's own sibling aliases (e.g. `sum` + `count` in one output row)
    can be divided via a residual `computed_field` to get an avg-shaped
    ratio, and (b) a second, coarser-grain Aggregate step validly chains
    after a pushed one as a residual multi-level rollup. Neither
    reproduces true per-row broadcast division. A first-class
    `%_of_total` fn (or a window/broadcast primitive) is parked, not
    scheduled — revisit only if real user friction shows up, per the
    Stage 1 digest's original framing.
  - **Aggregate pushdown pagination — DONE (Phase 9 Part 3).** `runEtl.ts`
    now pages a pushed aggregate's output by group-key keyset, page size
    `MAX_CHUNK_ROWS`, ordered by the group-by columns (`orderBySql` on
    `SqlDialectQuery`; a trailing `$sort` in the compiled Mongo pipeline).
    The keyset predicate is applied before grouping (`WHERE`/pre-`$group`
    `$match`) via `SqlGroupKeyCursor`, resolved through the same
    `ParamSink`/`resolveParamSink` pass as every other literal — never
    hand-appended after the resolve pass (see the arg(n)-desync warning
    this entry used to carry; that door is now closed the same way Part 2
    closed it for the row-keyset cursor). NULL group keys sort first on
    every dialect (`NULLS FIRST` forced on postgres). The old fail-at-cap
    guard (hard-fail when fetched rows exactly hit the cap) is removed;
    pagination supersedes it — hitting the cap now just means "there's
    another page," exactly like row-keyset. One known gap: a pushed
    aggregate prefix feeding a *further* residual stateful op (chained
    aggregates, e.g. group-by-A pushed then group-by-B residual) is not
    paginated inside `runStatefulResidual`'s internal loop — that path
    still treats a pushed aggregate prefix as always single-page
    (`isAggregatePushdown ||` short-circuit on its `isLastChunk`, with no
    loud guard anymore since the guard was removed everywhere). This
    combination is expected to be vanishingly rare (pushdown normally
    removes an aggregate step from `residualSteps` entirely), so building
    full duplicate group-keyset pagination machinery for it was skipped;
    revisit if a real workflow ever hits it — until then it risks a
    silent under-feed of the accumulator rather than a loud failure.
  - **Residual (non-pushed) aggregation buffers all per-group state in
    memory** (`residualTransform.ts`) — a `Map` of group-key → running
    accumulators, plus a `Set` per `count_distinct` aggregation. Fine at
    current chunk sizes; would not scale to unbounded cardinality group-
    bys or very wide `count_distinct` sets. Streaming/spillable
    aggregation is ledgered as a future item, not built.
  - **Pushed-aggregate structural limits** (`pushdown.ts`'s
    `splitPushable`): a pushed Aggregate step can only be preceded by
    `filter` steps, never `computed_field`/`drop_fields` (those force
    the aggregate to residual); and at most one Aggregate step is ever
    pushed per node — a second Aggregate step always falls to residual
    (the proven multi-level-rollup composition case above). Both are
    disclosed v1 limitations, not bugs.
- **Phase 8a (op registry + dialect adapter seam) — shipped, see
  `docs/decisions.md`'s matching entry for the full writeup.** One
  remaining item is a **named blocking prerequisite, not a someday
  item**: a shared DB-execution harness
  (`packages/schemas/src/ops/__conformance__/fixtures.ts`'s `OP_FIXTURES`
  run against a seeded sandbox DB, asserting real result rows, not just
  emitted query shape) **must be built before the first new op (Phase
  8b) lands** — shape-only conformance tests can't catch a wrong-but-
  internally-consistent emission. Until then, `aggregate-smoke.ts` /
  `aggregate-smoke-postgres-source.ts` / `dispatch-smoke.ts` remain the
  DB-backed proof for the 4 existing ops.
  Also flagged, not executed: `writeGrantStatement.ts`'s
  `WriteGrantStatementDialect` (`"mongodb"`) still diverges from
  `pushdown.ts`'s `SourceDialect` (`"mongo"`) — a small, behavior-neutral
  rename onto the shared enum, recommended but deliberately left
  untouched since it wasn't required by this phase's scope.
- **Scheduled work, not just an open observation: Postgres explicit-cast
  pass for untyped bind-parameters.** `docs/decisions.md`'s "Phase 8b-2a:
  Postgres CASE-branch literal typing" entry has now been sighted three
  separate times — `computed_field`'s conditional branches (8b-2a),
  `binary` arithmetic (8b-2b), and the `computed_field/postgres`
  conditional fixture in `ops-db-conformance.ts`'s live run (Phase 8b-2
  batch 1) — all the same root cause: Postgres infers an untyped bind
  parameter's type as `text` whenever it lands in a position with no
  adjacent typed operand to infer from. Three independent sightings is
  enough to promote this from a standing note to real, scoped work: a
  dialect-adapter change in `sqlShared.ts` that wraps every literal
  compiled to a bind parameter with an explicit Postgres type cast
  (`$n::type`, inferred from the literal's JS type at compile time)
  wherever it isn't already sitting next to a typed column reference —
  not just the `CASE`/`binary` shapes caught so far, since the entry's
  own analysis already names `UNION`/`COALESCE`-with-mixed-arguments as
  carrying the identical risk in principle. Needs its own phase slot
  (dialect-adapter change + a new conformance-fixture surface asserting
  the emitted JS type matches across all 3 dialects for every literal
  shape), not folded into whichever batch happens to next touch
  `sqlShared.ts`.
- Surface the numeric-precision platform constraint in product-facing
  docs (Phase 8b-2, pre-batch-5 hardening, Item 2): numeric/decimal
  values beyond float64 precision (~15-17 significant digits, or exact
  integers above 2^53) are lossy on read across all 3 dialects — proven
  live via `apps/worker/scripts/numeric-precision-probe.ts`, see
  `docs/decisions.md`'s Item 2 entry. A customer pointing a pipeline at
  a ledger or scientific dataset needs to know this before they run it,
  not discover it after silently getting rounded numbers back. Not a
  bug to fix (see decisions.md for why the alternatives are worse) —
  just needs to be documented for customers.
- **Golden corpus collection — start now (added 2026-09-21).** Phase 13
  (router + coercion/missing-value specialists) cannot be evaluated
  without a labeled corpus of real question→expected-behavior examples;
  building that corpus after Phase 13 starts means evaluating against
  data collected too late to catch early router mistakes. Start
  collecting labeled examples now, ahead of Phase 13, so the corpus
  exists and has some depth by the time it's needed.
- **Rename the original roadmap's Phase 8 (Console + audit) and Phase 9
  (hardening + self-host) as named milestones (added 2026-09-21).** The
  Phase numbering has drifted from the original roadmap (this session's
  work, e.g., is also informally "Phase 8" in decisions.md/PHASE8_EXIT.md
  but is unrelated to the roadmap's original Phase 8 Console+audit
  scope) — rename the roadmap's Phase 8/Phase 9 to named milestones
  (e.g. "Console + audit" / "Hardening + self-host") to remove the
  numbering collision. Console + audit is mandatory before Phase 15.
- **Phase 8b-3 deferred fallible candidates (added 2026-09-21).** 8b-3
  scoped `fallible` to exactly 6 call-fns (`to_number, to_integer,
  to_boolean, to_date, parse_date, parse_number`) — the ones that return
  NULL on invalid non-null input in every evaluator (step 1's inventory).
  Two more candidates were identified but deliberately deferred, not
  forgotten:
  - **Regex no-match** (`regex_extract`/`regex_match` returning
    NULL/false on a non-matching input) — arguably a "failure" in the
    same sense as a bad coercion, but conflating "the pattern didn't
    match" with "the input couldn't be parsed" would make `onFailure`
    fire on ordinary, expected regex misses (e.g. filtering rows where a
    pattern *doesn't* match is a normal use case, not an error state).
    Needs its own semantics discussion, not a mechanical addition to the
    `fallible` set.
  - **Divide by zero** (`divide`, and by extension `mod`/`quotient`) —
    today's residual/pushdown behavior for divide-by-zero already
    diverges by dialect in ways not yet fully agreement-tested (mysql
    returns NULL, postgres raises a native division-by-zero error,
    mongo/residual behavior not yet pinned) — folding this into
    `fallible` before that divergence is itself resolved would make
    `onFailure`'s "same predicate shape pushable everywhere" guarantee
    false for this function specifically. Revisit once divide-by-zero's
    own cross-evaluator agreement is established.
- **Shape-only conformance fixtures for `regex_extract`, `regex_replace`,
  `canonicalize`, `strip_accents` (added 2026-09-21).** §4 of
  `PHASE8_EXIT.md` notes these 4 functions are proven only via the live
  cross-evaluator agreement suite (real docker-sandbox execution), with
  no entries in `packages/schemas/src/ops/__conformance__/fixtures.ts`'s
  shape-only conformance suite at all — a real coverage gap for the
  faster, non-live test path. Add fixtures for all 4, including their
  non-default-pushability skip arms (`regex_extract`'s mysql skip,
  `regex_replace`/`canonicalize`'s mongo skip, `strip_accents`'s
  all-dialects skip).
- **Phase 10: scope MySQL's `HEX(BINARY col)` pagination cursor to string
  group keys only, once the profiler provides column types (added
  2026-09-21).** The Phase 9 close-out fix (`docs/decisions.md`) applies
  byte-order pagination to every mysql group-by key type unconditionally,
  since no column-type metadata is available at compile time to gate it —
  correct, but pays a `HEX(BINARY ...)` hidden-column cost even for keys
  where a native numeric/date comparison would already agree with a plain
  `ORDER BY`. Once the profiler surfaces real column types, restrict the
  `BINARY`/`HEX(BINARY)` treatment to string-typed group keys and let
  other types use a native, type-matched cursor comparison.
- **Phase 9: pre-check query per pushed fallible step, to restore
  failure visibility (added 2026-09-21).** Today a pushed
  `filter`/`computed_field`/`aggregate`-`having` step with a fallible
  call either forces itself (and every later step in the node) fully
  residual (`'fail'`/`'quarantine'`) or pushes silently with no failure
  count (`'null'`/`'drop'` — see `PHASE8_EXIT.md` §8). Add a pre-check
  query per pushed fallible step: `EXISTS(<failure predicate>)` detects
  a `'fail'` failure up front so the step can stay pushed for the main
  query instead of forcing itself and every later step residual;
  `COUNT(<failure predicate>)` restores an accurate failure count for
  pushed `'null'`/`'drop'` steps. Must land before Phase 13, when the
  missing-value specialist begins generating model-proposed `'drop'`
  policies at scale.
- **Phase 13: refuse/flag a workflow run when the live entity's
  `profile_hash` drifts from the profile a mapping/policy was proposed
  against (added 2026-09-21).** Phase 10 built the profiler
  (`source_profiles.profile_hash`, cached with a 24h TTL, manual
  Refresh in the source node's Profile tab) but it's advisory-only —
  nothing today reads `profile_hash` at run time. Phase 13's
  missing-value specialist (and any future model-proposed
  mapping/policy) should be generated *against* a specific profile
  snapshot; before a run applies that proposal, re-check the live
  entity's current `profile_hash` against the one the proposal was
  generated from, and refuse (or surface a re-review prompt) on a
  mismatch rather than silently applying a policy tuned for a schema
  shape that's since drifted.
- **Composite-PK extraction: reuse Phase 9's lexicographic keyset
  expansion (added 2026-09-21).** `runEtl.ts`'s plain (non-aggregate)
  extraction precondition only accepts a *single-column* primary key —
  both connector-supabase's `pg_catalog` PK query and connector-mysql's
  `column_key` PK query collapse a multi-column PK to `null`
  (`pkCols.length === 1 ? pkCols[0]! : null`), which then hits the same
  hard-fail as a genuinely key-less table. Phase 9 already solved the
  exact same "order and paginate by more than one column" problem for
  aggregate pushdown's group-key cursor (lexicographic tuple comparison
  compiled through `ParamSink`, plus the mysql `BINARY`/`HEX(BINARY)`
  collation fix for string columns — see `PHASE9_EXIT.md` and
  `docs/decisions.md`'s Phase 9 entries). Extend plain extraction's
  keyset pagination to accept a composite `primaryKey: string[]` and
  reuse that same lexicographic `(k1, k2, ...) > (cursor1, cursor2,
  ...)` comparison + cursor-tuple encoding, instead of continuing to
  refuse every composite-PK table/entity outright.
- **A strategy for views (added 2026-09-21).** Views have no primary
  key by definition, and `runEtl.ts`'s plain-extraction precondition
  currently refuses them exactly like any other key-less table
  (`entity.primaryKey` is always `null` for a view, hard error, no
  aggregate-pushdown exemption unless the view's own defining query
  happens to be one). Decide and design an actual strategy rather than
  leaving views permanently unextractable: candidates include (a)
  letting the user designate a column (or column set) on the view as an
  ordering/dedup key at mapping time, with a disclaimer that
  uniqueness/stability is unverified and on them; (b) a bounded
  unordered-but-deduplicated scan (extending the profiler's
  `no-key-scan`/`fetchUnkeyedPage` approach in `sampleEntity.ts` from
  "profiling only" to "actual extraction," with the same silent
  skip/duplicate risk under concurrent writes that implies and needs to
  be surfaced to the user, not hidden); or (c) requiring the view's
  underlying base table(s) to be introspected instead and refusing only
  when that's not resolvable. Needs a decision before the no-PK path is
  ever offered to users as anything more than a hard refusal.
- **Phase 11 follow-ups (added 2026-09-21):**
  - **Quarantine pushdown.** Quarantine writes today go row-by-row through
    `writeQuarantineRows` (`stagedWrite.ts`) inside the same chunk loop as
    the staging upsert — no batching/pushdown parity with the staging
    write path's `buildStagingUpsertSql` batching. Revisit if quarantine
    volume ever becomes a real per-chunk cost, not before.
  - **Quarantine retention.** `nia.nia_quarantine` is one fixed, long-lived
    table per destination database (`deriveQuarantineEntity`) — rows
    accumulate forever once `committed`, with no TTL/archival policy.
    The staging sweeper (24h) only covers `staging_objects`-registered
    staging tables, not quarantine rows. Needs its own retention decision
    (time-based purge? per-run archival table?) before quarantine volume
    in a long-running production destination becomes a real storage cost.
  - **Row-count reconciliation.** Nothing today cross-checks
    `workflow_runs.rows_processed` against the destination's actual
    post-apply row delta (e.g. via `pg_stat_user_tables` or an explicit
    `SELECT COUNT(*)` before/after apply) — the Phase 11 silent-rollback
    bug (see `docs/decisions.md`) was only caught by manual
    `pg_stat_user_tables` inspection, not by any automated check. A
    lightweight post-apply reconciliation assertion (destination count
    delta matches `applied`) would have caught this class of bug at the
    connector level immediately, rather than requiring a live smoke-test
    investigation.
  - **Mongo staged-mode testing — not skipped, correctly untestable.**
    `smoke:staged` only exercises postgres + mysql, per the plan; mongo's
    `/stage` unconditionally refuses staged mode on this sandbox's
    standalone `mongod` topology (no replica set — multi-document
    transactions aren't available), which is exercised directly by
    `connector-mongodb`'s own unit tests, not by `smoke:staged`. Actual
    staged-mode mongo behavior (apply-in-transaction on a real replica
    set) remains unverified against live infrastructure — needs a
    replica-set-topology sandbox variant to test for real, not a
    skip that needs revisiting so much as a capability gap in the
    current sandbox.
- **Phase 13 gate (added 2026-09-21) — deferred checks to run before
  Phase 13 starts, not before:**
  - Full `conformance:agreement` suite (all cases, not a subset).
  - All smoke scripts: `smoke`, `smoke:aggregate`,
    `smoke:aggregate:postgres-source`, `smoke:extract:postgres`,
    `smoke:write`, `smoke:write:mysql-mongo`, `smoke:staged`, `smoke:chat`,
    `smoke:mapping`, `smoke:profile`.
  - `kill-test` (etl-kill-resume-smoke's kill/redelivery path, direct
    mode — separate from `smoke:staged`'s own kill-after-chunk-1-resume
    scenario, which only covers staged mode).
  - Golden corpus evaluation (`eval:golden`, `eval:golden:plan`).
  - Cross-org RLS check on `source_profiles` (Phase 10 added this table;
    no RLS probe for it in `supabase/tests/rls_probes.sql` yet — needs
    one proving org A can't read/write org B's profiled-source rows).
  - Anon key can't read the `nia` schema on a real (not local) Supabase
    project — Phase 11's staging/quarantine tables live in `nia`, created
    ad hoc by the write-role credential via `/stage`'s `create` op; never
    verified against a real linked project that the anon key + PostgREST
    can't enumerate or query `nia.nia_stg_*`/`nia.nia_quarantine`.
  - Mongo staged mode on a real replica set, if still skipped by then —
    see this file's "Mongo staged-mode testing" entry above.
- **Schema-layer Part 3: pushdown for `to_json`/`flatten` (added
  2026-09-22).** Both new ops (`packages/schemas/src/ops/{toJson,flatten}.ts`)
  are declared `isPushable() { return false; }` unconditionally on every
  dialect — residual-only, per the schema-layer plan's explicit scope
  (`docs/plans/schema-layer.md` Part 3). Real pushdown is possible on at
  least some dialects and was deliberately deferred, not found infeasible:
  - `to_json`: postgres has native `to_jsonb(col)`/`row_to_json`; mysql 5.7+
    has `CAST(col AS JSON)`/`JSON_OBJECT`; mongo's aggregation values are
    already BSON-native, so a `to_json` step there is closer to a no-op
    relabel than a real transform. Each dialect's adapter would need an
    `emitSql`/`emitMongo` arm plus a `checkConfig`/fixture pass proving the
    pushed shape round-trips identically to the residual path's
    `JSON.stringify`-equivalent semantics (residual `applyResidual` today
    just copies the value through unchanged under the new field name —
    pushed emission must match that, not just "produce valid JSON").
  - `flatten`: postgres/mysql JSON path expressions (`col->>'key'`,
    `JSON_EXTRACT`) or mongo's `$replaceRoot`/`$mergeObjects`/dotted-path
    `$project` could express single-level flattening; `maxDepth > 1`
    recursion pushed into SQL/Mongo gets progressively less ergonomic
    (nested `JSON_EXTRACT` chains, repeated `$mergeObjects`) and may not be
    worth pushing past depth 1. Needs a design decision on how deep to push
    vs. fall back to residual, plus the same column-collision-detection
    logic `outputSchema` already does at schema time (see `flatten.ts`) —
    a pushed emission must fail the same way, not push a query that
    silently produces colliding columns.
  Both need conformance fixtures in
  `packages/schemas/src/ops/__conformance__/fixtures.ts` once pushdown
  lands, following the existing per-dialect-skip-arm pattern used for
  `dropFields`'s mongo-only pushability.
- **Unify `expression.ts`'s `typeOfExpr` with `niaExprType.ts`'s
  `typeOfExpr` (added 2026-09-22).** Two functions with the same name now
  coexist by construction, not by plan: `expression.ts`'s
  `typeOfExpr(expr: Expr): ExprValueType` is a narrow grammar-well-
  formedness classifier (`"scalar" | "boolean"` only, used by the parser/
  `ExprSchema`'s `superRefine` to reject ill-typed source); `niaExprType.ts`'s
  `typeOfExpr(expr: Expr, input: NiaSchema): ExprTypeResult` (Schema-layer
  Part 3) returns a full `NiaType`. They're exported side-by-side from
  `index.ts` today only by namespacing the newer one
  (`export * as niaExprType from "./niaExprType.js"`) to dodge a real
  `TS2308` ambiguous-export compile error — see `docs/plans/schema-layer.md`'s
  Part 3 plan-update entry for why. One `typeOfExpr` with one source of
  truth for "what type does this expression have" would be cleaner:
  candidates are (a) have `niaExprType.ts`'s version subsume
  `expression.ts`'s — every `"scalar"`/`"boolean"` classification is
  recoverable from a `NiaType` (`boolean` kind ↔ `"boolean"`, everything
  else ↔ `"scalar"`), so the parser/`superRefine` call sites could switch
  to calling the NiaType-returning version and deriving the coarser
  classification themselves, OR (b) rename one of the two so they stop
  sharing a name at all and the `export *` ambiguity (and the reader
  confusion of "which typeOfExpr is this") goes away without either
  function changing behavior. Not done now: `expression.ts`'s version has
  no `NiaSchema` to consult (it runs during parsing, before any op's
  input schema is known) and is called from hot parser code paths — folding
  it into (a) needs to confirm that's not a performance or ordering problem,
  which is real investigation, not a quick rename.
- **`change_graph`'s `z.unknown()` diff input can drift from `PlanDiff`
  undetected (added 2026-09-23).** `apps/api/src/copilot/tools/changeGraph.ts`'s
  `inputSchema.diff` is `z.unknown()`, not schemas' `PlanDiff` — `PlanDiff`'s
  `.default()`-bearing fields (`baseGraphVersion`, `ops`) make its Zod
  *input* type wider than its *output* type, which is incompatible with
  `ToolDefinition<TInput, TOutput>`'s `inputSchema: z.ZodType<TInput>`
  constraint (requires input===output). Real validation still happens —
  `applyPlanDiff` calls `PlanDiff.parse(input.diff)` itself — but the LLM's
  tool spec (`zodToJsonSchema` in `agentLoop.ts`'s `buildToolSpecs`) gets
  zero structural schema for `diff`, so the tool's hand-written prose
  `description` is the model's *only* source of truth for `diff`'s shape
  (see `docs/decisions.md`'s Copilot agent entry for the two real bugs this
  already caused: a false `baseGraphVersion`-omitted staleness conflict,
  and a silent `ops`-omitted no-op apply, both fixed by expanding that
  description). This is inherently fragile: nothing enforces that the
  description stays in sync with `PlanDiff`'s actual shape if the schema
  changes later — a field rename/addition to `PlanDiff` or `PlanOp` won't
  fail typecheck or tests here, it'll just silently make the description
  wrong again. Proper fix means resolving the underlying type-variance
  constraint so `change_graph` can use a real, schema-derived input type —
  either relaxing/widening `ToolDefinition.inputSchema` to accept a
  `z.ZodType` whose Input can differ from Output (and having
  `buildToolSpecs`/`executeTool` consistently pick the right one), or
  giving `PlanDiff` a parallel no-`.default()` "strict" variant for this
  one call site. Not done now — scoped as its own follow-up, not folded
  into the Copilot agent plan's v1 delivery.
- **Delete the old secret on a successful credential edit (added
  2026-09-24, secret-storage migration).** `updateConnection`'s credential-
  rotation path (`apps/api/src/services/connections.ts`) writes a brand
  new secret (`secretStore.put`) and repoints `connections.vault_secret_ref`
  at it, but never deletes the pre-edit secret it just replaced — every
  successful credential edit leaves the old row behind permanently. This
  predates the envelope-encryption migration (it was true of the old
  Vault-only path too — the live local DB had accumulated 54 Vault rows
  for only 31 live references before this session's backfill) and is
  unchanged by it: `nia_secrets` will accumulate the exact same class of
  orphan going forward unless this is fixed. Fix: once the new secret is
  written and the connections row update commits successfully, delete the
  previous `nia_secrets` row (and, during the dual-read migration window,
  the previous Vault row too, if that's what the pre-edit ref pointed at).
  Must not delete-before-commit (the existing "delete the *new* secret on
  a failed `dispatchTest`" rollback right above this path in
  `updateConnection` is the reverse case, and is already handled).
- **Equivalent orphan gap for `nia_write_*` roles left behind by grant
  rotation (added 2026-09-24, secret-storage migration).** Same shape of
  bug as the credential-edit orphan above, but for write-grant role
  rotation instead of connection secrets: confirming/rotating a write
  grant (`apps/api/src/services/grants.ts`) creates a new
  `nia_write_*` Postgres role/user plus a new secret for it, but nothing
  today drops the *previous* `nia_write_*` role when a grant is rotated —
  each rotation leaves the old role behind in the destination database
  indefinitely, alongside its now-orphaned write-credential secret. Needs
  its own fix (drop the old role, e.g. via the same `DROP ROLE`/`DROP
  USER` DDL `write_role_name` already exists to support at connection-
  delete time — see 0028_write_grant_role_name.sql's header comment) —
  not automatically covered by fixing the connections-secret orphan above,
  since it's a different resource class (a live destination-DB role, not
  just a `nia_secrets`/Vault row) with its own cleanup mechanics.
- **Azure Key Vault backend for `@nia/secrets`
  (docs/plans/secret-storage.md, added 2026-09-24).** `SecretStore` is
  designed with a pluggable backend seam (`createEnvKeySecretStore` is
  one implementation), but only the envelope-encryption-under-
  `NIA_SECRET_MASTER_KEY` backend exists today. An Azure Key
  Vault–backed implementation was scoped in the original plan as a
  later option (e.g. for self-hosted or enterprise deployments that
  want a managed HSM-backed store instead of an application-level
  master key) — not built, not started.
- **Remove the Vault fallback once every live `vault_secret_ref`/
  `write_credential_vault_ref` has been migrated (docs/plans/
  secret-storage.md, added 2026-09-24).** `SecretStore.get()` currently
  dual-reads: checks `nia_secrets` first, falls back to
  `resolve_connector_secret`/`decrypt_connector_secret_for_edit` (Vault)
  for any ref that predates the migration. This is intentionally
  temporary. Once `secrets-verify` reports zero `vault-only` refs against
  every real (non-local) environment that matters, remove the Vault
  fallback branch from `SecretStore.get()`, and only then consider
  actually deleting the Vault rows themselves (a separate, later step —
  not bundled with removing the fallback code path).
- **Local `supabase_vault` extension is missing `vault.delete_secret`
  (found data-access migration Step 4, added 2026-09-24).**
  `supabase/tests/rls_probes.sql` probes #45 and #50 both fail locally
  with `function vault.delete_secret(uuid) does not exist` — the local
  stack's `supabase_vault` extension is version 0.3.1, which only
  exposes `create_secret`/`update_secret` (confirmed via `\df vault.*`);
  `delete_secret` isn't in this version at all. `public.
  delete_connector_secret(uuid)` (0027_connection_lifecycle_audit.sql)
  calls `vault.delete_secret` internally, so both probes' cleanup step
  errors. Confirmed this is a pre-existing local-environment gap, not a
  regression from the data-access (PostgREST→pg) migration: re-ran both
  probes against the committed (pre-migration) tree via `git stash` and
  got the identical error. All 50 other probes pass, including every
  cross-tenant-isolation probe and the ones added by this migration's
  own work (`nia_secrets` RLS, probe #49) — tenant isolation is fully
  proven regardless. Not fixable by app code; needs the local Supabase
  CLI/`supabase_vault` extension updated to a version that ships
  `vault.delete_secret` before probes #45/#50 can be verified locally.
  Unverified whether a real (hosted) Supabase project's Vault extension
  has this function — check there before assuming this is only a local
  quirk.
- **e2e `app.spec.ts:24` ("New workflow" -> "New project" creates a
  project) is broken, pre-existing, unrelated to the data-access
  migration (found data-access migration Step 4, added 2026-09-24).**
  Test does `getByRole('button', { name: 'New workflow' }).first().click()`
  then `getByRole('button', { name: 'New project', exact: true }).click()`
  — but the sidebar's actual "+" button (`Sidebar.tsx`) has
  `aria-label="New"`, not "New workflow"; "New workflow"/"New project"
  only exist as separate dropdown-menu buttons revealed after clicking
  "New" first. The test never clicks "New" to open that menu, so it waits
  30s for a "New workflow" button that isn't on the page yet. Confirmed
  pre-existing: `e2e/app.spec.ts` and `Sidebar.tsx` are both byte-identical
  to committed HEAD (`git diff HEAD` empty for both) — nothing in this
  migration touched either file, so the mismatch predates it. Fix is a
  one-line test reorder (click "New" first), not attempted here per
  scope — this is a test bug, not an app bug.
- **e2e visual-regression diffs on `/login` and `/signup` (1440px
  baseline) are pre-existing, unrelated to the data-access migration
  (found data-access migration Step 4, added 2026-09-24).** ~1300-1700px
  diff (~0.01 ratio) on both, concentrated almost entirely on the logo
  wordmark and heading glyphs ("Nia Core", "Sign in" / "Create your
  account") — consistent with the font-antialiasing-jitter class of
  causes already documented above (Phase 5 Session 5 visual-baseline
  entry), not layout/app drift. Confirmed pre-existing: `visual.spec.ts`,
  `app/login/`, and `app/signup/` are all byte-identical to committed
  HEAD (`git diff HEAD` empty). The one uncommitted change to shared CSS
  (`packages/ui/src/theme.css`) only touches landing-page dialog/button
  styles (`.hl-field`, `.hl-dialog-*`) — no `@font-face` or auth-screen
  rule changed — so it can't be the cause either. Not re-baselined here;
  needs its own investigation/fix pass (likely a font-load-timing race
  before the screenshot, same shape as the previously-fixed causes).
- **`@supabase/supabase-js` deliberately left in `apps/api` and
  `apps/web` (data-access migration Step 5 close-out, 2026-09-24).**
  Not removable — both uses are the Auth layer, which was explicitly
  out of scope for this migration (data access only; a separate
  "auth via Better Auth" migration is planned later, see memory/
  decisions). `apps/api`: `src/lib/supabaseClient.ts`
  (`createRequestSupabaseClient`, per-request bearer-token client) and
  `src/lib/cookieSupabaseClient.ts` (`createCookieScopedSupabaseClient`
  via `@supabase/ssr`) back real `supabase.auth.*` calls;
  `req.supabase` (`src/types/express.d.ts`) is still set by
  `requireAuth` for this reason. `apps/web`: `src/lib/supabase/server.ts`
  backs `src/lib/auth/actions.ts` (signInWithPassword, signUp,
  signInWithOAuth, resetPasswordForEmail, updateUser, signOut) and
  `src/lib/auth/session.ts` (`getUser`) — all real Auth calls, not data
  access. `apps/worker`'s production `src/` is fully clean (zero
  imports) — its `package.json` dependency is kept alive only by
  `scripts/` (smoke tests: `dispatch-smoke.ts`, `chat-smoke.ts`, etc.,
  and the Vault→`nia_secrets` backfill/verify tooling in
  `scripts/lib/secretsMigration.ts`, `secrets-backfill.ts`,
  `secrets-verify.ts` — see `docs/plans/secret-storage.md` Step 2C).
  Those scripts would need their own migration/retirement before
  `apps/worker`'s `package.json` entry can actually be dropped; not
  attempted here, out of scope for Step 5.
- **`canvas.spec.ts` isolation double-run (idle dev servers, run twice,
  data-access migration Step 4, 2026-09-24): same 5 tests failed
  identically both runs, but root cause is test-fixture/data
  contamination from this session's own repeated e2e re-runs against
  the persistent local dev DB, not a code regression.** Failures:
  line 228 (`drag 2 sources...`), 1108 (`connection-driven sections`),
  1143 (`zero-connection persona`), 1207 (`destination drawer —
  empty-database postgres`), 1386 (cascades from 1207). Root-caused via
  each test's `error-context.md`: (1) **1143 is a duplicate of the
  already-logged `app.spec.ts:24` bug** — clicks
  `getByRole('button', {name: 'New workflow'})` directly, same
  `aria-label="New"` mismatch, not new. (2) **1108** expects exactly 7
  draggable rail entries (canvasA's org should have exactly 3
  connections: mysql/mongodb/supabase → 3 sources + 3 destinations + 1
  transform) but got 15 — implies ~7 connections now exist on that
  org, i.e. extra connections accumulated from other tests in this
  session's repeated full-suite re-runs, never torn down between runs
  against the same persistent DB. (3) **228** times out in `beforeEach`'s
  self-heal loop: `.react-flow__node.first()` click is intercepted by
  an overlapping sibling node — the shared "Canvas E2E Workflow"
  fixture has leftover/overlapping nodes from a previous interrupted
  run that the self-heal loop couldn't cleanly delete. (4) **1207**
  times out on the same rail (consistent with the same connection-count
  contamination changing rail contents/labels); **1386** cascades from
  1207 (same serial describe block). Not fixed here — needs either a
  DB/fixture reset (connections on canvasA's org, node cleanup on the
  shared workflow fixture) before a genuinely clean re-run, or
  per-test isolation (fresh org/workflow per run) as a longer-term fix.
  Do not treat this as a data-access-migration regression.
  **Follow-up (same day): fixture cleanup performed, targeted objects
  only** — deleted the 5 accumulated postgres connections on canvasA's
  org (`@postgres-empty-db-e2e` + 4 `@postgres-empty-db-e2e-run-*`
  duplicates from repeated 1207/1386 runs; `connections` table only,
  `write_grants`/`source_profiles`/`staging_objects` cascade-deleted
  with them by FK), restoring it to exactly the 3 canonical
  mysql/mongodb/supabase connections `dev-bootstrap.ts` creates, and
  deleted the `workflow_graphs` row for the shared "Canvas E2E
  Workflow" (3 leftover nodes, none of which `supabase/seed.sql`
  seeds — that file deliberately gives this workflow no
  `workflow_graphs` row at all, so deleting it restores the exact
  as-seeded state). Did not touch `test-supabase-1`/`test-neon-1`
  connections (confirmed they don't currently exist anywhere in the
  DB) or run any DB-wide reset. **Re-ran `canvas.spec.ts` once more,
  isolated/idle, per the stop-rule above: 1108 now passes** (confirms
  it really was the extra-connections contamination). **228, 1143,
  1207, 1386 still fail, but three of the four now fail with a
  DIFFERENT error than the contaminated run** — i.e. they are not
  fixture pollution, they are real, separate issues:
  - **1143**: unchanged, still the `app.spec.ts:24` duplicate (test
    bug, not app bug) — see above.
  - **228**: the `beforeEach` self-heal no longer times out (fixture
    cleanup fixed the overlapping-node click-intercept), but the test
    body now fails later: `connectNodes` produces 0
    `.react-flow__edge` elements instead of the expected 2. This lines
    up with an already-existing, already-documented (2026-09-18)
    comment in `canvas.spec.ts` itself, a few tests below this one in
    the same `.serial` block, describing "a real, reproducible visual
    bug... two overlapping node popovers superimposed... as if a
    leftover node from the prior test's fixture state is still painted
    underneath" with root cause explicitly noted as "not yet isolated"
    — very plausibly the same underlying react-flow DOM/unmount timing
    issue, just manifesting as a failed edge-connect instead of a
    visual diff here. Not re-investigated further per the stop-rule.
  - **1207 / 1386**: also a new failure mode — gets much further than
    before (installs PostgreSQL, creates the connection, drags both
    nodes, configures the source node's table) but then the
    destination node's "Loading tables…" spinner never clears within
    5s. Checked and ruled out two hypotheses: (a) the `empty_e2e`
    sandbox Postgres database has zero tables (not stale-table
    accumulation — `ensureEmptyPostgresDatabase()` never drops
    anything, but nothing had actually landed there); (b) `/schema` is
    a synchronous `apps/api` route (`connections.ts`, calls
    `getConnectionSchema` directly), not a BullMQ job routed through
    `apps/worker` — a worker restart mid-run (tsx watch picked up
    dist-file changes from this same session's earlier `pnpm
    build`/`test` runs around the same time) was a plausible confound
    but doesn't fit the request path. Root cause not yet found — needs
    its own investigation with a live `apps/api` log captured during
    the run (the existing `/tmp/api-dev.log` was stale, from a
    previous day's process). Stopping here per the stop-rule; these 3
    (228, 1207, 1386) should be treated as open, real bugs, tracked
    separately from the now-resolved fixture-pollution issue.
- **Process gap: several `canvas.spec.ts` tests assume fixtures they
  never create or tear down themselves, so repeated local runs
  silently pollute shared state and produce failures that look like
  app regressions but are actually test-data buildup (found/fixed
  2026-09-24, see the entry above for the specific incident).**
  Concretely: (1) the "palette purity — connection-driven sections"
  test (line ~1108) hardcodes an expected rail-entry count that is
  only correct if canvasA's org has exactly the 3 connections
  `dev-bootstrap.ts` seeds — any other test that adds a connection to
  that same org (e.g. the empty-database postgres tests) permanently
  breaks this assertion until someone manually deletes the extra
  connection; the test itself never checks or resets the connection
  set it depends on. (2) The "empty-database postgres" tests (lines
  ~1207, ~1386) create a `PostgreSQL` connector install + connection
  (and the `1386` variant mints a brand-new, `Date.now()`-suffixed
  connection every single run) but never delete either — every local
  run adds one more. (3) The shared "seeded workflow drag / connect /
  reload" `.serial` block (line ~168) only self-heals by deleting
  *nodes* it finds already selected via the UI one at a time in
  `beforeEach`; it doesn't reset `workflow_graphs` directly, so an
  interrupted/killed run (a real risk in dev — see the worker-restart
  note above) can leave it in a state the self-heal loop itself can't
  cleanly recover from (overlapping node positions breaking the
  click-driven delete). Recommendation: either (a) each of these tests
  should create its own scoped fixtures (fresh org/connection per
  test, like the "zero-connection persona" and cross-org tests already
  do) instead of reusing canvasA's shared org/connections, or (b) add
  a global-setup step (`e2e/globalSetup.ts` already exists and runs
  before the suite) that resets canvasA's connections to exactly the
  3 seeded ones and clears the shared workflow's `workflow_graphs` row
  before every run, rather than relying on manual cleanup like the one
  just done. Not implemented here — flagging for a follow-up pass.

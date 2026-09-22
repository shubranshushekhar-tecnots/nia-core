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

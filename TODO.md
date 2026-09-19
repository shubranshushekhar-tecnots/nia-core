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
  - **Aggregate pushdown never paginates.** `runEtl.ts` executes a
    pushed-down aggregate as a single non-paginated query capped at
    `MAX_CHUNK_ROWS` (1000 output rows) with `isLastChunk` forced `true`
    — the runner's keyset-pagination model is keyed on the source
    primary key, which GROUP BY collapses, so there's no cursor to
    paginate over post-aggregation. UPDATED (Block 6 addendum): a
    workflow whose grouped output would exceed 1000 rows no longer
    silently truncates — `runEtl.ts` now hard-fails the run (before
    `dispatchWrite`, zero destination rows written) whenever the fetched
    row count exactly hits the cap, publishing an `error` run-stream
    event with a clear "aggregate result may exceed N groups" message.
    This guard is the honest v1 stopgap, not the real fix: it can't
    distinguish "exactly N groups, no truncation" from "truncated at N",
    so a legitimately-N-group workflow will false-positive fail and must
    raise the cap or reduce cardinality. The real fix remains an
    aggregate-aware pagination cursor (e.g. keyset over the group-by
    columns themselves) so large-cardinality group-bys can page like any
    other query — revisit if/when that becomes a real workload.
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

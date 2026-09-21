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

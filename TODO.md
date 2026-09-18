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

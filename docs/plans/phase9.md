Phase 9 plan. First, save this entire prompt verbatim to docs/plans/phase9.md. If your context is compacted or you lose track of the plan, re-read that file instead of stopping. Don't commit it until the end of Phase 9.

Move fast: implement as written. Keep tests to the listed ones.

Status: Step 0 (Phase 8 committed) and Step 1 (inventory) are done. Inventory findings:
- ParamSink resolves once, at the end, in physical order select → where → groupBy → having. Mongo has no ParamSink (literals embed directly).
- queryBuilder.ts's non-aggregate keyset cursor hand-appends to the already-resolved params. Safe today only because HAVING never coexists.
- Pushed aggregates group only by raw columns (confirmed).
- STOP hit: residual aggregates run per chunk and upsert each chunk's partial result, so later chunks overwrite earlier ones. Live silent-wrong-results bug.

Work in this order.

Part 1: Residual stateful ops across chunks (bug fix, keep separable)
- Add a property to each op module declaring whether its residual execution is row-local (safe per chunk) or stateful (needs all input rows). Today only aggregate is stateful. The residual executor must refuse, with a hard error, to run a stateful op on a single chunk.
- runEtl: split residual steps at the first stateful op. Row-local steps before it run per chunk. The stateful op accumulates across all chunks using per-group accumulators, never buffered rows. After the last chunk, emit its output, run every remaining step on that output, then write. No destination write before the stateful op has seen every chunk.
- Group-count cap: configurable, default 100,000. Exceeding it fails the run with a clear error naming the cap. Add spill-to-disk to TODO.md as deferred.
- Resume: accumulator state is in memory, so if a plan contains a residual stateful op, resume restarts extraction from the beginning and ignores the checkpoint. Add persisted accumulator state to TODO.md as deferred.
- Exposure: check the 4 local workflows for multiple transform nodes or a non-pushable aggregate (the remote project has 0 workflow_graphs rows). Record the result in docs/decisions.md.
- Tests: worker unit tests for (a) a residual aggregate over 3+ chunks (small chunkSize) matching the single-chunk result, (b) a run killed after chunk 1 and resumed matching the full-data result, (c) a residual aggregate over the group cap failing loudly. Plus a unit test that the executor rejects a stateful op run on a single chunk.

Part 2: Keyset through ParamSink
- Resolve keyset cursor conditions into the ParamSink before resolveParamSink runs (pass the cursor into compileSql rather than appending afterward), so every param binds in textual order.
- Migrate queryBuilder.ts's existing non-aggregate cursor to the same path and delete the hand-append pattern.

Part 3: Aggregate pagination (pushed)
- Page pushed aggregate output by group key, page size MAX_CHUNK_ROWS, ordered by the group-by columns.
- Apply the keyset predicate before grouping (WHERE on SQL, $match before $group on mongo). HAVING stays after grouping. Valid because pushed group keys are raw columns.
- NULL group keys sort first on every dialect (force NULLS FIRST on postgres). Expand the keyset predicate lexicographically with explicit IS NULL handling. Don't use row-constructor comparison.
- ORDER BY, GROUP BY, and the keyset comparison must use the same collation (standing rule 2).
- Checkpoint the last group-key tuple as the cursor, the same way Extract checkpoints, so pushed aggregate runs resume.
- Remove the fail-at-cap guard and its TODO.md / docs/history/PHASE8_EXIT.md entries; pagination supersedes it.

Part 4: Pushed onFailure pre-checks
- For each pushed fallible step, run one pre-check query before extraction, against the same source and upstream filters:
  - 'fail': EXISTS(failure predicate). If true, abort before any write, with the same error as the residual path. The step stays pushed and no longer forces itself and later steps residual.
  - 'null' / 'drop': COUNT(failure predicate), reported as the step's failure count.
- If docs/history/PHASE8_EXIT.md §8 has a "no failure count when pushed" risk, mark it resolved and point to this fix.

Part 5: Consistency (document, don't fix)
- Pages, chunks, and pre-checks are separate queries, not a snapshot. Rows changed mid-run can shift between pages or escape a pre-check, as with existing chunked Extract. Record this in docs/decisions.md.

Tests for Parts 2–4 (minimal; this is the full list)
- Add a test-only page-size override so pagination tests don't need 1000+ groups.
- One adversarial live agreement case, all four evaluators, page size 2: GROUP BY two columns, HAVING with a param, a NULL group key, and string keys differing only by case ('a' and 'A'). Assert the exact group set.
  If MySQL merges 'a' and 'A' into one group, apply the collation rule to GROUP BY and ORDER BY and report it as a found bug.
- Update the existing onfailure cases for pre-checks: pushed 'drop' now reports its count. Add one case where pushed 'fail' aborts with the correct count while staying pushed (assert residual count 0).
- Unit test: pushed aggregate pagination resumes from a checkpointed cursor.

Close Phase 9
- docs/decisions.md: one short Phase 9 entry covering these decisions and anything found along the way.
- docs/history/PHASE9_EXIT.md: short. What shipped, bugs found, open risks.
- Full verification once, covering 8b-3 and Phase 9: typecheck (all four packages), unit tests (guardrails, schemas, worker), the full ops-agreement suite, and all smoke scripts. Cite counts. If Docker crashes, restart and rerun; discard crashed runs.

Don't commit. Output: findings and any deviations with reasons, test results with counts, the untruncated git status --porcelain, and Part 1's files listed separately so I can commit the bug fix on its own.

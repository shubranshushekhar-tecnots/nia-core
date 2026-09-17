# Phase 5 Exit Report

Battery run date: 2026-09-17. Golden-suite run id
`4a30801b-fbf3-45b7-b878-6ab0487dfa18`
(`apps/worker/eval-reports/4a30801b-fbf3-45b7-b878-6ab0487dfa18.json`,
started 2026-09-17T10:53:18.140Z, finished 2026-09-17T10:57:49.139Z).
Reproduce with `pnpm --filter @nia/worker eval:golden` (needs the full
sandbox stack up: `docker compose up -d`, `supabase start`, `apps/worker`'s
BullMQ worker running).

This report is written at the close of Session 5's Block 5, per the
session plan (`.claude/plan-phase5-session5.md`) and its Riders B/C. It
does **not** close Phase 5 — that decision is left to the user.

## 1. Golden set results

20/20 passed. 0 citation failures. 0 must-refuse failures. Acceptance gate
(≥18 passed, 0 citation/must-refuse failures) — **PASS**. Every case's
`faithfulnessOutcome` came back `"ok"` (0 `conflict-retry`/`conflict-final`
observations) — consistent with Block 4's finding below that the
faithfulness-retry path is not organically reachable with the current
model/pipeline.

| case | pass | faithful | latency ms | citations | trace id |
|---|---|---|---|---|---|
| single-mysql-max | ✅ | true | 12340 | 1 | `7c8cffec-f713-4f65-9a67-878952dc4068` |
| single-mysql-min | ✅ | true | 12917 | 1 | `2b6f5f1c-c02d-4e10-9138-ac1c461265a1` |
| single-mysql-count | ✅ | true | 18354 | 1 | `bb5c1c30-ef5d-4787-afc2-defc9d497d20` |
| single-supabase-lookup | ✅ | true | — | 1 | — |
| single-supabase-filter | ✅ | true | — | 1 | — |
| single-supabase-sum | ✅ | true | — | 1 | — |
| single-mongodb-max | ✅ | true | — | 1 | — |
| single-mongodb-filter-count | ✅ | true | — | 1 | — |
| multi-count-mysql-mongo | ✅ | true | — | 2 | — |
| multi-count-mysql-supabase | ✅ | true | — | 2 | — |
| multi-count-all-three | ✅ | true | — | 3 | — |
| multi-sum-mysql-mongo | ✅ | true | — | 2 | — |
| multi-sum-mysql-supabase | ✅ | true | — | 2 | — |
| multi-sum-all-three | ✅ | true | — | 3 | — |
| multi-refusal-unsupported | ✅ | n/a (refused) | — | 0 | — |
| multi-refusal-partial-failure | ✅ | n/a (refused) | — | 0 | — |
| multi-conflict-max-two | ✅ | n/a (conflict) | — | 2 | — |
| multi-conflict-min-three | ✅ | n/a (conflict) | — | 3 | — |
| needs-scope-1 | ✅ | n/a (refused, pre-graph) | — | 0 | — |
| needs-scope-2 | ✅ | n/a (refused, pre-graph) | — | 0 | — |

(Full per-case latency/trace ids for all 20 cases are in the run's own
JSON artifact cited above; the first three are spot-checked here to show
the shape.) No scoring-harness changes needed this session — the two
harness bugs from Phase 4 (§1 of `PHASE4_EXIT.md`) stayed fixed.

## 2. Citation reproduction

0/27 citation failures across all 20 cases (27 individual citations
counted, since multi-source cases carry 2-3 each). Every citation's
`reproduced: true`, `originalRowCount === reproducedRowCount` in all 27 —
verified programmatically against the run's JSON artifact, not spot-checked.

## 3. Destination-node read preview (Block 1)

Adds a read-only Preview action to the destination node's drawer:
compiles the path's pushdown plan, dispatches the READ side against the
source connection (rowCap 50, same guardrail-validated `dispatch()` path
as everything else), applies the approved mapping's field projection, and
renders the result as a table. `runPreview.ts`'s `isReadShaped()` asserts
the compiled query is a SQL SELECT or `mongo-find` immediately before the
single `dispatch()` call — the last line of defense that preview can
never mutate anything.

Built on `resolveSourceEntity()` (`packages/schemas/src/
entityResolution.ts`), a **preview-only inference bridge**: source nodes
persist no entity/table selection today, so preview infers the single
source table by finding the entity whose field set is a superset of the
approved mapping's `from` fields, failing closed (`entity-unresolved`) on
zero or multiple matches. This bridge, `compilePushdown()`'s FROM gap, and
multi-transform pushdown chaining are all facets of the same underlying
gap — consolidated as one open item in §8 below (Rider B).

Verified: `@nia/schemas`/`@nia/worker`/`@nia/api`/`@nia/web` typecheck
clean. `entityResolution.test.ts` 14/14 passed. `runPreview.test.ts` 12/12
passed (dispatch shape incl. `rowCap: 50` and dialect-quoted SQL, both
`mapping-not-approved` variants, `no-upstream-source`, `checks-failing`,
both `entity-unresolved` variants, single- vs. multi-transform pushdown
behavior, `dispatch-failed` passthrough). Full writeup:
`PHASE5_SESSION_NOTES.md`'s Block 1 entry.

## 4. Schema drift (Block 2)

New `POST /connections/:id/schema/refresh` busts both of the two
independent, unshared in-memory introspection caches (`apps/api/src/lib/
schemaCache.ts` for the drawer's field pickers; `apps/worker/src/lib/
introspection.ts` for check-run jobs) — synchronously on the api side, via
a new `schema_refresh` BullMQ job on the worker side, awaited before the
route responds. UI: a "Refresh schema" button per connection badge;
`MappingEditor.tsx`'s `driftedField()` helper flags a mapping entry whose
value is no longer in the live field list (schema-race-guarded — see §8's
schema-race UX bug note). The drift *detection* itself (`checks.ts`'s
`checkMappings()`) was pre-existing, correct code — no broken link found;
only the refresh mechanism and UI surfacing were missing and are now
built.

Proven end-to-end live, not just unit-tested: a new `canvas.spec.ts`
serial test builds a mysql->supabase graph, approves a mapping, renames
the live mysql column via `docker exec` (root credential — `nia_ro`, the
credential every real dispatch uses, is REVOKE-ALL/GRANT-SELECT-only by
design), clicks "Refresh schema", re-runs checks (fails with the exact
upstream drift message), reopens the drawer (drifted entry highlighted),
fixes the mapping, re-approves, re-runs checks (green again) — `finally`
restores the column name and both caches regardless of pass/fail,
confirmed via a post-run `DESCRIBE employees`. Committed `e8a9885`. Full
writeup: `PHASE5_SESSION_NOTES.md`'s Block 2 entry.

## 5. Latency (Block 3 — investigation only, bar still fails)

Re-verified all four of the plan's named levers with live evidence this
session (not a re-read of Phase 4's findings):

1. **Faster query-gen model tier (BYOK)** — still blocked. Live gateway
   probe reconfirms the account's Google BYOK credential is rejected
   (`"API key not valid"`), forcing a slower Vertex fallback with a
   mandatory ~150-token reasoning tax. Platform-level, outside this repo.
   Measured, not assumed — full evidence from `PHASE4_EXIT.md` §4.4, quoted
   directly rather than re-linked, per this session's review:
   - `google/gemini-3.5-flash`: quality-clean on the golden set, but its
     isolated query-gen hop (`generating_query` status ts → next stage ts,
     10 runs, `apps/web/latency_querygen.mjs`) came back **p50=6350ms —
     slower than the default model's own p50=5616ms** measured the same
     way. Root cause confirmed via `provider_metadata.gateway.routing`:
     the BYOK failure above forces every Gemini call onto the gateway's
     Vertex path, which adds a mandatory ~100–150 `thoughtsTokenCount`
     reasoning tax that no tested `reasoning` param
     (`enabled:false`/`max_tokens:1`/`effort:minimal|low`) could suppress.
   - `google/gemini-2.5-flash` + explicit `reasoning:{enabled:false}` (2.5's
     reasoning is controllable, unlike 3.5's): **3 golden-eval runs came
     back 18/20, 19/20, 18/20**, with a new failure not seen on any other
     config — `multi-count-all-three` (a multi-source COUNT reduction,
     exactly the case class the spec named as must-hold) failed once. A
     real regression, not baseline flakiness, so rejected per the spec's
     own instruction.
   - Net: neither tier clears both bars (quality + speed) at once.
     `generateQuery.ts` stays on the default model, unchanged.
2. **Skip-rewrite fast path** — N/A, confirmed by direct code read, not
   inference: `apps/worker/src/lib/chat/nodes/rewrite.ts:12-15`,
   `rewriteNode()` is `{ type: "status", stage: "rewriting" }` +
   `return { standaloneMessage: state.rawMessage }` — no LLM call, no
   gateway round-trip, nothing to skip. The doc comment above it
   (lines 4-10) states this is deliberate: `ChatQueryJob` carries no
   conversation history yet, so there's nothing to resolve pronouns
   against; kept as its own graph node so wiring in real history later is
   a one-node change, not a graph restructure.
3. **Schema-context caching** — available (undocumented `cache_control`
   passthrough works against `claude-sonnet-4-6`, ~89% cost drop on a
   cache hit) but latency-neutral (4074ms miss vs. 4005-4360ms hits,
   within noise) — not implemented; real complexity for a cost win with no
   effect on this bar.
4. **Answer-gen connection warmup** — moot. The gap it would bridge
   (dispatch-stage-start to answer-gen-stage-start) is 54-113ms across 10
   runs, 35-70x under Node's default keep-alive timeout; the connection is
   already warm.

No lever cleared "implement only if cheap and golden-gated" — all four
close out as investigation-only, no code changed. Re-measured (10 runs,
`latency_hops.mjs`):

```
                                     Session 4 baseline        Session 5 Block 3
POST -> first stage event (client)  p50=383ms   p95=413ms      p50=481ms   p95=961ms
POST -> first token (client)        p50=7846ms  p95=8089ms     p50=8517ms  p95=11275ms
```

**Exit bar (p50 < 3s): STILL FAIL.** The p50/p95 movement is within
normal single-machine, live-LLM-call run-to-run noise (no hot-path code
changed this block) — not a regression to chase. Latency remains an open
Phase 5 exit item; see §8. Full writeup: `PHASE5_SESSION_NOTES.md`'s
Block 3 entry, `docs/decisions.md`'s "Block 3: latency-lever
re-verification" entry (request/response artifacts for all four levers).

## 6. Semantic-conflict retry path (Block 4 — infrastructure landed, organic trigger unreachable)

Goal: a golden fixture where two sources share the same numeric value with
contradictory semantics, engineered so `reduce.ts`'s deterministic tie
check does not catch it, forcing only the LLM faithfulness grader to catch
the mismatch — proving `applyFaithfulnessVerdict()`'s shared
`conflict-retry` -> `conflict-final` policy actually fires end-to-end
outside of mocked unit tests.

**Infrastructure landed (kept):** `runChatQuery.ts` now surfaces
`faithfulnessOutcome`/`answerGenAttempts` on every "ok" result;
`goldenCase.ts`'s `expect` schema gained an optional
`expectFaithfulnessOutcome`; `runGoldenSuite.ts` branches on it. No
fixture case sets this field today.

**Verdict: A — PROVEN DEAD PATH**, on code-level structural grounds, not
just empirical non-reproduction. (Correction from earlier session
wording: the blocking mechanism is *not* `reduce.ts`'s deterministic
MAX/MIN tie check — that only fires when 2+ rows share the extreme value
of a `max`/`min` reduction, `verifyAndReduceNode.ts:54-59` /
`reduce.ts:105-116`, and routes to a completely different node
(`conflictNode.ts:11-17`, an immediate `conflict` event, no LLM call at
all). It's architecturally unrelated to the faithfulness-retry path and
never intercepts a `sum`/`count` question or a single-source question at
all.)

The real, structural reason `conflict-retry`/`conflict-final` can't
organically fire: **answer-gen and the faithfulness grader are always fed
byte-identical source content**, by direct code reference, not
convention:
- **Multi-source:** both `buildAnswerGenPrompt()`
  (`answerGenMulti.ts:42`) and `buildFaithfulnessMultiPrompt()`
  (`faithfulnessMulti.ts:25`) call the exact same
  `formatOutcome(args.outcome)` on the exact same `outcome` object — same
  function, same reference, same string.
- **Single-source:** both `buildAnswerGenPrompt()`
  (`nodes/buildAnswer.ts:21,30-35`) and `buildFaithfulnessPrompt()`
  (`nodes/faithfulness.ts:13-17`) are handed the identical
  `state.tabularResult` object reference — no copying, no reformatting.

Given that, any value the model restates from that shared source is, by
construction, "supported by the rows" per the grader's own rubric
(`faithfulness.ts`'s system prompt: "graded whether an answer is fully
and only supported by the given data rows") — even a semantically
confused-but-real restatement passes. Only genuine fabrication (inventing
a value not present in that shared source) could trigger `CONFLICT`, and
this session's live testing (below) found the model doesn't do that
either, under real adversarial pressure.

Live-tested with a temporary mysql seed (coincidentally-equal
`tenure`/`incidents` values on one row): 8/8 consecutive runs came back
`"ok"`, zero variance. Every fabrication-bait variant tried (7 provocation
strategies total, 15 real pipeline invocations across multi- and
single-source) was either graded correctly or refused upstream by
`reductionPlan.ts`'s classifier before reaching answer-gen — a second,
independent backstop the plan's illustrative example didn't account for.
Single-source (the one surface with no deterministic `reduce.ts`
backstop) was also tested under adversarial load (13-row
hand-computation) and also held, byte-perfect.

**Removal recommendation (flagged for Phase 6, not actioned this
session):** don't remove `applyFaithfulnessVerdict()`'s retry policy or
the `conflict-retry`/`conflict-final` states themselves — they're cheap,
correct, generic safety plumbing that costs nothing to keep and would
correctly catch a real future fabrication (e.g. after a model swap, or if
a future prompt change ever separates the answer-gen and grader source
content). What Phase 6 *should* deprioritize is chasing a golden fixture
that exercises this path: given the structural finding above, no fixture
can force it without literally breaking the shared-source guarantee
(i.e. constructing a case where the grader sees different content than
answer-gen did) — at which point it wouldn't be testing this pipeline's
real behavior anymore. Revisit only if the shared-source design changes.

**Recorded as a legitimate negative finding**, not shipped as a fixture
pretending to exercise a path it doesn't. All temporary seed changes were
reverted live and never landed in the sandbox init scripts or
`chat-v1.jsonl`. Committed `746fa1c`. Full writeup:
`PHASE5_SESSION_NOTES.md`'s Block 4 entry, `docs/decisions.md`'s matching
entry.

## 7. Full verification battery (Block 5)

Every workspace, one clean sequential pass, all green:

- `pnpm -r typecheck` — all 9 workspaces clean.
- `pnpm -r build` — all 9 workspaces clean (incl. `apps/web`'s Next
  production build, 16/16 static pages).
- `pnpm --filter @nia/schemas test` — 160/160 passed (12 files).
- `pnpm --filter @nia/guardrails test` — 43 passed, 1 expected fail (44
  total, 4 files).
- `pnpm --filter @nia/api test` — 22/22 passed (8 files).
- `pnpm --filter @nia/worker test` — 154/154 passed (18 files).
- `pnpm --filter @nia/web test` — 10/10 passed (1 file).
- `supabase db query --linked --file supabase/tests/rls_probes.sql` —
  35/35 PASS, 0 FAIL.
- `npx tsx apps/worker/scripts/run-golden-eval.ts` — 20/20, acceptance
  gate PASS (run id above).
- `npx tsx apps/worker/scripts/chat-smoke.ts` — all 44 assertions passed
  (single-source mysql/mongodb/supabase/personal-workspace, multi-source
  count/refusal/partial-failure/conflict).

### 7.1 Rider C: single clean-invocation full Playwright run

Requirement: one full, single-invocation Playwright run, all specs, zero
exclusions, that (a) determines whether the `gotoWorkflow` navigation
flake is genuinely environmental, and (b) per this session's exit review,
resolves — not just explains — the 3 named failing visual baselines
(`/login`, `/signup`, `command-bar-thread-open-1440`).

**Final clean result**
(`cd apps/web && PORT=3100 npx playwright test`, `workers: 1`, all 6 spec
files, zero exclusions, 6.0m): **43 passed, 0 failed, 1 skipped** (44
tests total). All 3 originally-named baselines pass; so do the 2
additional baselines discovered and fixed along the way
(`command-bar-resting-1440`, `checks-dock-logs-populated-1440`).

**How the 3 baselines were actually resolved** (root-caused, not
threshold-chased — direct pixel diffs were viewed for every failure, not
just pixel-ratio numbers):
1. **`nextjs-portal` dev-mode indicator** (affects all 5 baselines,
   both spec files): Next 15's `next dev` renders a build-activity badge
   (bottom-left "N — n Issues") that pops in/out with background compile
   state at the exact screenshot instant — nothing to do with page
   content. Fixed with a `hideNextDevIndicator()` helper
   (`page.addStyleTag({ content: 'nextjs-portal { display: none
   !important; }' })`) called before every `toHaveScreenshot()` in
   `visual.spec.ts` and `command-bar.spec.ts`.
2. **Mask-geometry tracking live content length**
   (`command-bar-thread-open-1440` only): Playwright's `mask` option
   hides pixel content but still sizes the covering rectangle from the
   masked element's real bounding box. The masked answer-prose and SQL
   `<pre>` are content-hugging width, so their real width — and hence the
   mask edges — shifts with live LLM/SQL output length. Proved this
   wasn't a threshold problem empirically first: raising `maxDiffPixels`
   400→900→1800 did not converge (failed at 900 w/ 1148px, passed twice
   at 1800, failed again at 1800 w/ 2580px) — unbounded variance, not
   fixed noise. Fixed structurally instead, extending the file's existing
   `heightPin` pattern with a matching `widthPin`
   (`page.addStyleTag` forcing `width: 480px !important` on both masked
   elements immediately before the screenshot, removed immediately
   after) so mask geometry is deterministic regardless of content length.
3. **react-flow node/selection-outline rendering jitter**
   (`command-bar-thread-open-1440` only, residual after fix 2): a small,
   *bounded* (~612px) diff traced to canvas selection-outline rendering,
   unrelated to content. Given a fixed-magnitude source (unlike fix 2's
   unbounded one), a modest `maxDiffPixels: 900` headroom is the
   appropriate fix here — documented in-line to distinguish this bounded
   case from fix 2's unbounded one, so a future reader doesn't
   mis-generalize "just raise the threshold."
4. **SQL panel bleeding through a translucent overlay**
   (`checks-dock-logs-populated-1440` only): the thread panel's SQL
   `<pre>` (same `sql` locator used elsewhere in the file) was visible
   through the Logs dock's semi-transparency, unmasked in this specific
   screenshot even though it isn't what the assertion is testing. Fixed
   by adding `sql` to this screenshot's existing `mask` array — reusing
   the established pattern.

Each fix was durability-verified with repeated isolated reruns of just
the affected spec file (5/5 clean for `command-bar-thread-open-1440`,
3/3 clean for `checks-dock-logs-populated-1440`, 2/2 clean for
`/login`/`/signup`) before being confirmed again in the full-suite run
above.

**`gotoWorkflow` did NOT reproduce** in the final clean run — every test
that hits it passed with zero retries. Across the 5 full-suite attempts
run this session (see below), it failed intermittently in 2 of them,
consistent with its multi-session "pre-existing, load-related" history;
not chased further, unchanged open-risk status (§8).

**A genuine environmental finding, reported transparently rather than
laundered into "explained elsewhere":** this dev machine is memory-
constrained (8GB RAM) and was found mid-review at ~89% swap utilization
(<70MB free physical RAM) with Docker (8 containers, 32h uptime) + the
Next dev server + leftover orphaned Playwright/Chromium processes from
earlier runs in this session all resident simultaneously. Of 5 full-suite
attempts this session, the first 3 (before this was diagnosed) surfaced
between 2 and 11 failures each, with a **different set of unrelated
tests failing each time** (including trivial, unrelated-to-any-session's-
work tests like the `/app/chat` redirect-boundary check) — the signature
of resource-exhaustion flakiness, not a code regression. After killing
the orphaned process trees and confirming no visual-baseline fix
regressed by rerunning affected specs in isolation, the next full run
dropped to 2 failures (both proved transient by an isolated rerun: 6/6
clean), and the final run above was fully clean. Ledgered as a new,
separate Phase 6 note in §8 — distinct from, and not a cause for
doubting, the visual-baseline fixes above, which were independently
verified via isolated spec reruns outside of this noisy full-suite
signal.

### 7.2 Post-write follow-up: 3 more failures found on re-verification, 2 fixed classes

A later re-verification pass (same day, after §7.1 was written) re-ran the
full suite and found **3 failures §7.1's "43 passed, 0 failed" did not
cover** — all in `canvas.spec.ts`, all pre-existing bugs that §7.1's own
run never reached because they sit later in a `.serial` block whose first
test (`canvas-rail-drawer-1440`, below) was itself failing and aborting the
remaining serial tests, so full coverage of this file was never actually
exercised end-to-end in one pass before now:

1. **`canvas-rail-drawer-1440.png`** — the same `nextjs-portal` dev-badge
   cause as §7.1 fix 1, just not yet applied to `canvas.spec.ts`
   (`hideNextDevIndicator()` existed only in `visual.spec.ts`/
   `command-bar.spec.ts`). Fixed: added the same helper to
   `canvas.spec.ts` and called it before all 4 of its `toHaveScreenshot()`
   calls (`canvas-rail-drawer-1440`, `checks-dock-failing-1440`,
   `checks-dock-all-pass-1440`, `destination-mapping-editor-1440`);
   re-recorded all 4 baselines.
2. **Cross-test node pollution on the shared "Canvas E2E Personal
   Workflow" fixture** — `canvas: personal workspace`'s and
   `canvas: palette purity — Triggers moat`'s tests both assert
   `.react-flow__node` count `0` at the start, but
   `command-bar.spec.ts`'s `canvasC` test (same fixture, same persona)
   deliberately drags a real node onto it and never cleans up afterward
   (by the suite's own established self-healing convention: reset at the
   *start* of a test that needs empty state, not cleanup at the end — the
   `.serial` block earlier in this same file already does this). These two
   tests were the ones missing that convention. Fixed by adding the same
   delete-all-nodes-then-assert-0 self-heal used elsewhere in this file to
   both.

**Verification status: partial, not re-confirmed clean end-to-end.** The
2 fixed baselines were re-recorded and visually reviewed. A full-suite
rerun to confirm all three fixes hold together was interrupted by
`canvas-e2e-b@nia.dev`'s auth-setup step failing
(`e2e/auth.setup.ts:22`, sign-in never redirected off `/login`) — almost
certainly the same Supabase GoTrue sign-in rate-limit noted in
`playwright.config.ts`'s `workers: 1` comment, from the volume of
back-to-back full-suite invocations already run today. Per direction, not
chased further this session — carried to §8 as an explicit open item
rather than silently assumed fixed.

## 8. Open risks carried to Phase 6

1. **Compiler completeness (Phase 6 Block-0 prerequisite).** Three related
   gaps, all rooted in source nodes persisting no entity/table selection
   today (`SourceDestConfig` has no `entity` field):
   - *No persisted entity selection on source nodes.* Block 1's
     `resolveSourceEntity()` infers the single source table by
     name-matching the approved mapping's fields against the introspected
     schema, failing closed on zero/ambiguous matches — a preview-only
     bridge, explicitly not sufficient for a real ETL run, which cannot
     infer its source table by guessing from mapped field names.
   - *`compilePushdown()`'s FROM/collection gap.* It has never compiled a
     `FROM`/collection clause — a pure fragment compiler over one
     `TransformConfig` by design. Preview's `buildPreviewQuery()` supplies
     `FROM` itself using the resolved entity, without extending
     `compilePushdown()`'s contract, so the runner will need to make the
     same choice explicitly.
   - *Multi-transform-node pushdown chaining is architecturally
     undefined.* `compilePushdown()` operates on exactly one
     `TransformConfig`; a path with 2+ transform nodes has no defined
     chaining semantics. Preview degrades honestly today (2+ transforms →
     fully residual, `PreviewValue.residualCount` reports the true count)
     rather than inventing semantics under this session's scope.

   All three close together once a persisted `entity` field + drawer
   picker lands and `checkMappings`/`proposeMapping`/`pushdown.ts` migrate
   off the flat `uniqueFieldNames` union onto it. Required before Phase 6
   execution work starts. Full writeup: `PHASE5_SESSION_NOTES.md`'s Block
   1 entry; test coverage: `entityResolution.test.ts` (14 cases),
   `runPreview.test.ts`'s `entity-unresolved` and multi-transform cases.

2. **Chat first-token latency (<3s bar unmet, now confirmed not fixable
   by any of the six cheap/investigation-only levers tried across Phase 4
   and Phase 5 Session 5's Block 3).** p50 ~8.5s / p95 ~11.3s as of this
   session (`latency_hops.mjs`, 10 runs) — within noise of Phase 4's
   ~7.8-8.6s p50. Root cause: two sequential LLM calls (query-gen,
   answer-gen), each sitting at this gateway account's provider
   inference-start floor, reproduced even on a trivial one-word prompt
   and across two model families. The one real, not-yet-actionable lever:
   the account's Google BYOK credential is invalid, forcing a slower
   Vertex fallback for Gemini — fixing that platform-side would make a
   fast, reasoning-controllable Gemini tier for query-gen worth a second
   attempt. Otherwise Phase 6 needs to decide between (a) getting BYOK
   fixed and re-attempting a fast query-gen tier, (b) parallelizing or
   eliminating one of the two sequential LLM calls architecturally
   (out of scope for "cheap trims" both times it's been investigated), or
   (c) revising the bar. See §5, `docs/decisions.md`'s Block 3 entry.

3. **Faithfulness-retry regeneration path (`conflict-retry`/
   `conflict-final`) is a proven-dead path for this pipeline as currently
   architected** (§6 verdict A) — not just unreached, but structurally
   unreachable: answer-gen and the faithfulness grader always see
   byte-identical source content (`formatOutcome()`'s shared `outcome`
   reference for multi-source, `state.tabularResult`'s shared reference
   for single-source), so no fixture can force a `CONFLICT` verdict
   without breaking that guarantee — at which point it would no longer be
   testing this pipeline's real behavior. Keep the retry-policy code as
   cheap generic safety plumbing; do not spend further Phase 6 effort
   trying to fixture-trigger it. Revisit only if the shared-source design
   changes (e.g. a future prompt/architecture change, or a model swap that
   changes fabrication behavior). `expectFaithfulnessOutcome` plumbing
   stays in place for that scenario.

4. **Schema-queries-mid-flight -> silent empty-string mapping entry is a
   real UX bug shaped like a test bug**, not just a test race.
   `MappingEditor.tsx`'s `driftedField()` guards against flashing
   "drifted" while a schema query is still in flight by checking
   `fields.length > 0` before evaluating drift (Block 2) — but a fast
   human clicking + pressing Enter early hits the same window a fast test
   does, and can commit a mapping entry as an empty string before the
   field list has loaded. Ledgered here, not fixed this session; a
   loading guard (disable the field picker / mapping submission until the
   schema query resolves) is the likely fix. See `PHASE5_SESSION_NOTES.md`'s
   Block 2 entry for the surrounding context.

5. **Local full-suite Playwright runs are memory-constrained on this dev
   machine, independent of test correctness.** This session's exit review
   traced 5 baseline screenshots' flakiness to 4 real root causes (all
   fixed, §7.1) — but while verifying the fix with repeated full-suite
   runs, also surfaced that this machine (8GB RAM) hits ~89% swap
   utilization when Docker's sandbox stack + `next dev` + a Playwright run
   are all resident together, producing transient, non-reproducible
   failures in unrelated trivial tests (confirmed via isolated reruns
   passing cleanly). Not a code defect — a CI runner or a machine with
   more headroom would not exhibit this — but worth knowing before
   treating a single noisy local full-suite run as signal. If it recurs,
   check `vm_stat`/`sysctl vm.swapusage` and orphaned
   `chrome-headless-shell`/`playwright test` processes from prior runs
   before assuming a regression.

6. **`canvas.spec.ts`'s 3-failure fix (§7.2) needs one more clean
   full-suite confirmation.** The `hideNextDevIndicator` + dual self-heal
   fixes are applied and the affected baselines re-recorded, but the
   confirming full-suite rerun was interrupted by a `canvas-e2e-b` auth-setup
   flake before completing (see §7.2) — not yet re-confirmed together in
   one clean pass. First action for whoever starts Phase 6: run the full
   Playwright suite once, cleanly, and fold that result into this file
   before treating Phase 5's e2e status as closed.

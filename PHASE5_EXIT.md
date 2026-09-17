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
2. **Skip-rewrite fast path** — N/A. `rewrite.ts` is already a pure
   pass-through with no LLM call to skip.
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

**The mechanism is empirically unreachable with the current pipeline.**
`formatOutcome()` hands the entire winning row to both the answer-gen and
faithfulness-grader prompts, so restating any of that row's real values is
correctly graded `OK`. Live-tested with a temporary mysql seed
(coincidentally-equal `tenure`/`incidents` values on one row): 8/8
consecutive runs came back `"ok"`, zero variance. Every fabrication-bait
variant tried (7 provocation strategies total, 15 real pipeline
invocations across multi- and single-source) was either graded correctly
or refused upstream by `reductionPlan.ts`'s classifier before reaching
answer-gen — a second, independent backstop the plan's illustrative
example didn't account for. Single-source (the one surface with no
deterministic `reduce.ts` backstop) was also tested under adversarial
load (13-row hand-computation) and also held, byte-perfect.

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

Requirement: one full, single-invocation Playwright run on a quiet
machine (load average < 2, all specs, `workers` policy as configured, zero
exclusions), specifically to determine whether the `gotoWorkflow`
navigation flake (reported as "pre-existing, load-related" in three prior
sessions with no clean-run attempt) is genuinely environmental or a named
bug.

**Machine load was not actually under 2** at run time (`uptime` showed
2.89-4.85 across pre-run checks) — this IDE's own renderer/GPU helper
processes and macOS's Virtualization framework (backing Docker, which the
sandbox DBs the tests depend on require) are both baseline overhead that
can't be stopped without breaking the environment or the test
prerequisites. Reported honestly rather than claimed as met. One
first-attempt run was discarded: it failed immediately with `EADDRINUSE`
because a stale dev server (corrupted by an intervening `pnpm -r build`
overwriting its `.next` dev-mode chunks with production output) was still
squatting on port 3100 — killed the stale process, cleared `.next`, reran
clean.

**Clean single-invocation result**
(`cd apps/web && PORT=3100 npx playwright test`, `workers: 1`, all 6 spec
files, zero exclusions, 4.0m total): **40 passed, 3 failed, 1 skipped**
(44 tests total).

- **`gotoWorkflow` did NOT reproduce** — every test that hits it,
  including the two new, heaviest Block 1/Block 2 additions
  (`canvas.spec.ts`'s destination-preview test and schema-drift test,
  8.4s and 17.3s respectively), passed on the first attempt with zero
  retries anywhere in the run. This is the first genuinely clean
  single-invocation result across the flake's three prior "documented"
  mentions. Per Rider C, this is evidence the flake is load-related, not
  a code bug — but see the caveat immediately below: this run's own load
  average never actually dropped under 2, so "quiet" here means
  "quieter/more isolated than a normal working session," not "verified
  clean at the requested bar." Worth one more clean-run attempt on a
  machine with no IDE overhead if the flake resurfaces.
- **2 of the 3 failures are a known, pre-existing chore, not a
  regression:** `visual.spec.ts`'s `/login` and `/signup` baseline diffs
  (5182px and 5960px, ~1% pixel ratio) are documented in
  `PHASE5_SESSION_NOTES.md`'s Session 1 close-out and `TODO.md` as
  pre-existing, confirmed via git history to be unrelated to any
  session's canvas/command-bar/chat work. Unchanged status; still ledgered
  as a chore.
- **1 failure is the same known-chore class, confirmed via git log:**
  `command-bar.spec.ts:157` ("canvasC ... gets a cited answer through the
  command bar") failed its `command-bar-thread-open-1440.png` screenshot
  assertion (1148px diff, `maxDiffPixels: 400`). This baseline was
  specifically re-targeted by a prior session (commit `6dbb3c8`) at this
  single-connection personal-workspace test to eliminate multi-source
  citation instability (masking the answer prose + pinning the thread
  panel's height). `git log` on the baseline PNG and on the page/component
  it covers confirms neither has been touched since — same pre-existing,
  unrelated ~1% pixel-ratio drift class as `/login`/`/signup`, not a
  regression from this or any other session's work. Consolidated with
  those two into one `TODO.md` chore.
- **`chat.spec.ts:56`** ("refused case renders the refused state") is
  skipped via a literal `test.skip(..., async () => {})` — an empty,
  pre-existing stub, not introduced this session (confirmed via
  `PHASE5_SESSION_NOTES.md`'s Session 4 close-out, which already logged
  this same skip as "pre-existing, undocumented before that session — not
  introduced by it"). Still an open, low-priority coverage gap, unchanged
  status.

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
   `conflict-final`) remains unproven live**, now backed by a real,
   evidenced investigation rather than just an unstaffed gap: Session 5's
   Block 4 spent 7 provocation strategies / 15 real pipeline invocations
   trying to organically trigger it and could not, for structural reasons
   (deterministic multi-source reduction, an upstream classifier refusing
   multi-fact questions, and reliable model arithmetic even adversarially)
   documented in §6. The `expectFaithfulnessOutcome` plumbing is in place
   for if/when a real trigger is found (e.g. after a model change, or a
   prompt/architecture change that removes one of the backstops) — this
   is now a "revisit if circumstances change" item, not an open TODO to
   force this session.

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

5. **3 stale visual baselines still un-re-baselined**
   (`visual.spec.ts`'s `/login`/`/signup`, `command-bar.spec.ts`'s
   `command-bar-thread-open-1440`) — all pre-existing ~1% pixel-ratio
   diffs confirmed via `git log` to be unrelated to any session's work,
   most recently reproduced by this session's Block 5 full-battery
   Playwright run (§7.1). Consolidated into one `TODO.md` chore.

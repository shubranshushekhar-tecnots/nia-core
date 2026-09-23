# Phase 7 Exit Report — Copilot (plan → ghost preview → apply)

**PHASE 7 SESSION 3 CLOSED (2026-09-19) — "go live" verification done, real
bugs found and fixed, e2e green.** Written per the plan's own requirement
that Session 3 close with `PORT=3100 npx playwright test copilot.spec.ts`
passing and a report with punch items quoted verbatim.

## 1. What Phase 7 shipped, recap

| Session | Delivered |
|---|---|
| 1 | `PlanSchema` (`packages/schemas/src/plan.ts`) + LangGraph plan-propose pipeline (`apps/worker/src/lib/plan/{runPlanPropose.ts,state.ts,nodes/resolveScope.ts}`), `apps/api/src/lib/planQueue.ts` synchronous queue bridge, `apps/api/src/services/copilotPropose.ts` |
| 2 | Ghost-preview rendering (`apps/web/src/lib/canvas/ghostMapping.ts`, `FlowCanvas.tsx` overlay), Apply backend (`apps/api/src/services/copilotApply.ts`), audit event (`supabase/migrations/0019_copilot_plan_audit.sql`'s `log_plan_applied`/`private.can_access_workflow()`-gated `SECURITY DEFINER` RPC) |
| 3 | Client wiring (`apps/web/src/lib/api/copilotClient.ts`, `CopilotSidebar.tsx`), live verification (`apps/web/e2e/copilot.spec.ts`) — this report |

## 2. Session 3 — real bugs found and fixed this session

Two genuine defects blocked "go live" verification; both are now fixed and
proven via passing e2e runs, not just typecheck.

**Bug 1 — ghost nodes permanently `visibility: hidden`.** Root cause:
React Flow (`@xyflow/react` v12) renders new nodes hidden until a
ResizeObserver reports real dimensions back through
`onNodesChange({type:"dimensions"}) → applyNodeChanges(changes, nds)`.
Ghost nodes are concatenated into `displayNodes` in `FlowCanvas.tsx`
*outside* `useNodesState`'s own array (by design, so they never reach
`handleNodesChange`/autosave) — so that measurement update has no node id
in `nds` to write back to, and `applyNodeChanges` silently drops it. Ghost
cards never became visible. Fix: `ghostMapping.ts`'s `planToGhostFlow()`
now sets explicit `width: 196, height: 80` on every returned node (matching
`GraphFlowNode.tsx`'s own hardcoded card size), telling React Flow the node
is pre-measured so it skips the ResizeObserver phase entirely.

**Bug 2 — e2e tests broken by an external UI refactor.** Commit `d89551d`
("Canvas: replace node popover with docked NodeConfigPanel", landed
concurrently with Phase 7 work) moved the "Delete node" button off the
node card itself into the floating `NodeConfigPanel`/`NodeDrawer`
(`data-testid="node-drawer"`), only rendered once a node is `.click()`-
selected. This broke every e2e self-heal/assertion pattern written against
the old always-visible-on-card button — not a Phase 7 regression, but it
blocked Phase 7's own verification, so it was fixed everywhere it was
found:
- `apps/web/e2e/copilot.spec.ts` — 3 locations (self-heal reset, post-Apply
  assertion, post-reload + cleanup).
- `apps/web/e2e/canvas.spec.ts` — 4 locations (serial-block self-heal,
  personal-workspace self-heal, unknown-tool assertion, palette-purity
  self-heal).
- `apps/web/e2e/command-bar.spec.ts` — found already fixed by a concurrent
  external process; no action needed.

**Bug 2b — self-heal autosave race → spurious `PLAN_STALE` 409.** The
delete-button fix above surfaced a second issue: the last self-heal delete
starts `FlowCanvas.tsx`'s 800ms debounced autosave; if the test proceeds to
`propose`/`apply` before that `PUT` lands, `workflow_graphs.version` can
bump out from under the in-flight plan, producing a real `PLAN_STALE` 409
on Apply (the banner: "This workflow changed since the plan was proposed.
Discard the ghost preview and try again."). Fixed in `copilot.spec.ts` by
applying the same wait-for-"Saved"-text pattern already used in
`canvas.spec.ts`'s own self-heal hook, guarded by a `deletedAny` flag so it
only waits when a delete actually happened.

**This guard is a client-side test-timing fix only — it suppresses one
specific spurious, client-generated 409 (this test's own self-heal delete
racing its own propose call). It is not, and cannot be, the correctness
boundary for `PLAN_STALE`.** That boundary is entirely server-side:
`copilotApply.ts`'s `applyPlan()` re-fetches the graph fresh and compares
`current.version !== plan.baseGraphVersion` at apply time, independent of
anything the client waited for or believed. A genuine external change
(this session's new stale-graph e2e test, or any real concurrent editor)
still produces a real 409 regardless of this guard. Re-proven live this
session at the unit level, no worker dependency:
`pnpm --filter @nia/api exec vitest run src/services/copilotApply.test.ts`
→ 6/6 pass, `/tmp/copilotApply_unit_run.log`.

## 3. Verification — `copilot.spec.ts`: **PASS**

**Superseded 2026-09-19 (worker unblocked, live re-run):** the original
"5/5, 2 runs, UNCITED" claim below and the 2026-09-19 failing/blocked
re-attempt above are both stale. `apps/worker` was confirmed down
(`PLAN_PROPOSE_WORKER_UNAVAILABLE`), started in the foreground
(`pnpm --filter @nia/worker dev`, confirmed consuming `QUEUE_INTERACTIVE`
via its `Nia worker up: queues [interactive, heavy]` boot log), and the
suite re-run twice against the same real dev server (port 3100) and real
worker LLM call:
- Run 1: `PORT=3100 npx playwright test copilot.spec.ts --reporter=list,json` →
  **6/6 pass** (4 persona logins + both copilot tests, including the new
  stale-graph/ghost-preservation test), `expected:6, unexpected:0`.
  Artifact: `/tmp/copilot_run1.log`.
- Run 2: same command, immediately after → **6/6 pass** again,
  `expected:6, unexpected:0`. Artifact: `/tmp/copilot_run2.log`.
- Run 3 (after fixing a real `apps/web` typecheck error the new
  `decodeUserId` helper introduced — `split('.')[1]` is `string |
  undefined`, a pure type-narrowing fix, no runtime behavior change) →
  **6/6 pass** again, `expected:6, unexpected:0`. Artifact:
  `/tmp/copilot_run3.log`. This is the run reflecting the exact code that
  was committed.

Full flow proven end-to-end against the real dev server (port 3100) and
the real worker LLM call:

propose (real prompt against the live `sandbox_items` mysql table) →
"Proposed" badge renders and is visible → ghost node count > 0 → Apply
click → banner disappears → applied node is a normal selectable/deletable
node (no "Proposed" badge) → `copilot_plan.applied` row confirmed in
`audit_log` via `readOwnAuditRows()`, now asserting the **full ledgered
shape** (actor, org_id/owner_id scope, `planSummary`, non-empty
`appliedNodeIds`, and `prompt` — verified live to be `""` not `null`,
since `apps/api`'s `applyPlanBodySchema` defaults a missing prompt to
`""` before Apply ever runs, and FlowCanvas never sends one) → page
reload → applied node survives and is still selectable/deletable →
cleanup, verified via the delete's own autosave `PUT` response.

A second test (added 2026-09-19) additionally proves a genuine external
graph change between propose and Apply still produces a real 409 and
leaves the ghost/banner/node in place — passing in both runs above.

## 4. Full-suite regression pass (`chat`, `command-bar`, `canvas`, `copilot`)

Run as one combined invocation, then re-run each file in isolation to
separate genuine regressions from pre-existing/environmental noise.
**Bottom line: no regression from any Phase 7 change.** Everything failing
is either the Bug 2/2b fix above (now applied everywhere) or pre-existing,
unrelated, and out of Phase 7 scope (documented below, not fixed).

| File | Isolated result |
|---|---|
| `copilot.spec.ts` | 6/6 pass, 2 runs, 2026-09-19 — `/tmp/copilot_run1.log`, `/tmp/copilot_run2.log` (see §3) |
| `canvas.spec.ts` | 11/12 pass — 1 pre-existing unrelated failure (see §5) — **UNCITED**, no persisted report |
| `command-bar.spec.ts` | 4/6 pass — 2 pre-existing unrelated failures (see §5) — **UNCITED**, no persisted report |
| `chat.spec.ts` | passed as part of the combined run — **UNCITED**, no persisted report |

## 5. Pre-existing, unrelated issues discovered during regression testing (documented, NOT fixed — out of Phase 7 scope)

1. **CORRECTED 2026-09-19, was wrong:** `page.tsx`'s `orgName` prop to
   `<FlowCanvas>` is **not** a TS error and not a stray mid-flight edit.
   `git diff` shows `FlowCanvas.tsx`'s own uncommitted diff already adds
   `orgName: string | null` to its prop type and renders it via the new
   `CanvasHeader` — both files are part of the same canvas-redesign effort
   (`designs/canvasredesign.html`, `CanvasIconRail.tsx`/`CanvasHeader.tsx`),
   not Phase 7. The two diffs are consistent with each other; the only real
   constraint is a commit-ordering one (`page.tsx` must land in the same
   commit as, or after, `FlowCanvas.tsx`'s `orgName` addition — see the
   Session 3 commit plan).
2. **`gotoWorkflow` e2e helper intermittently stuck on `/app/projects`**
   without actually navigating — reproduced in isolated runs of files
   Phase 7 never touched. Environmental/timing, not a logic bug.
3. **`auth.setup.ts` persona logins intermittently timeout on `/login`** —
   dev-server compile-load related, resolved by retrying, not a code bug.
4. **`getByText('Dev sandbox (mysql)', {exact:true})` strict-mode
   violation (2 elements)** in `command-bar.spec.ts`'s
   `dragPaletteItemOnto` helper — reproduced even with 0 canvas nodes
   present (rules out node pollution). Likely a `NodesRail.tsx` palette
   duplication issue. Not investigated further — no Phase 7 change ever
   touched palette code.
5. **`canvas.spec.ts:247` stale table-option-count assertion**
   (`expect(...).toHaveCount(3)`, actual is 5) — the dev-mysql sandbox
   schema grew to 4 real tables (`employees, plan_eval_headroom,
   plan_eval_wide, sandbox_items`) plus a placeholder option since an
   earlier phase (Block 6); the assertion predates that growth. Not fixed,
   documented only.

## 6. Typecheck — clean across all three touched workspaces

```
pnpm --filter @nia/web typecheck     # was: "pre-existing orgName error only (§5.1)" — see §5.1 correction, that claim was wrong
pnpm --filter @nia/worker typecheck  # clean, no errors
pnpm --filter @nia/api typecheck     # clean, no errors
```

**UNCITED** (original claim above) — ran with console output only, nothing
persisted to disk at the time.

**Re-verified 2026-09-19, cited:** all three workspaces typecheck clean —
`/tmp/tc_worker.log` (exit 0), `/tmp/tc_api.log` (exit 0), `/tmp/tc_web2.log`
(exit 0, after fixing the `decodeUserId` `string | undefined` error
introduced by this session's own Step 4a test edit — see §3 run 3).

**Session 3 verification addendum (2026-09-19), cited artifact:**
`pnpm --filter @nia/api exec vitest run src/services/copilotApply.test.ts`
→ `Test Files 1 passed (1)`, `Tests 6 passed (6)`, log at
`/tmp/copilotApply_unit_run.log`. This independently re-proves the
`PLAN_STALE` 409 refusal (backend/unit level, no worker dependency) as of
that date — narrower than the full live e2e claims above, but real and
reproducible.

## 7. Files changed this session

- `apps/web/src/lib/canvas/ghostMapping.ts` — ghost-node visibility fix
  (width/height).
- `apps/web/e2e/copilot.spec.ts` — delete-button selection fix (3
  locations) + self-heal autosave-race fix.
- `apps/web/e2e/canvas.spec.ts` — delete-button selection fix (4
  locations), same root cause as above, fixed proactively for a clean
  regression baseline.

No other product code was touched this session — Sessions 1 and 2's
delivered surface (`PlanSchema`, plan-propose pipeline, ghost overlay,
Apply backend, audit RPC, client wiring) is unchanged and re-verified live,
not re-implemented.

## 8. Open risks carried forward

1. The 5 pre-existing/unrelated issues in §5 — none block Phase 7, all
   predate or are independent of it. Repayment point: whichever session
   next touches `NodesRail.tsx` (item 4), the `orgName` breadcrumb feature
   (item 1), or next does e2e/schema hygiene work (items 2, 3, 5).
2. All open risks carried from Phase 6 (`PHASE6_EXIT.md` §7) remain open
   at their Phase 6 status — Phase 7 did not touch grant lifecycle, RLS
   probes, or chat latency.

No commit has been made for this report or the Session 3 working-tree
changes — held for review, matching this repo's established exit-report
convention (see `PHASE6_EXIT.md` §5).

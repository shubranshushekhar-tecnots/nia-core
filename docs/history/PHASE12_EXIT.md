# Phase 12 exit report

Covers `docs/plans/phase12.md`. Full narrative and rationale:
`docs/decisions.md`'s "Phase 12: the diff model..." entry.

## What shipped

- **Diff format (`packages/schemas/src/planDiff.ts`).** `PlanDiff` = a
  list of ops (`addNode`, `removeNode`, `updateNode`, `addEdge`,
  `removeEdge`, `addStep`, `removeStep`, `updateStep`, `moveStep`)
  addressed by stable id. Every update/remove carries a full "before"
  snapshot; every add/update carries the full "after" — no JSON
  patches. `validateDiffStructure` simulates applying a diff against a
  graph and rejects dangling edges (a `removeNode` not paired with
  explicit `removeEdge`s for its edges) and cycles. `TransformStep`
  gained a stable `id` (`nodeConfig.ts`'s `ensureStepIds`, assigned on
  read for pre-existing steps via `ensureGraphStepIds`).
- **Apply (`apps/api/src/services/copilotDiffApply.ts`).**
  `applyPlanDiff` mirrors `copilotApply.ts`'s `applyPlan` shape (fresh
  fetch, `baseGraphVersion` staleness check, validate, write via the
  same `putWorkflowGraph`), plus backfills step ids and records a
  `copilot_applied_plans` row.
- **Revert.** `revertPlan` builds `invertDiff(originalDiff, { baseGraphVersion: <live> })`
  and runs it through the identical apply path (same validation, same
  graphVersion check). `checkRevertConflicts` refuses (409
  `REVERT_CONFLICT`, full conflict list, no automatic merging) if any
  element the original diff touched no longer matches what it left
  behind. The original row is marked reverted
  (`mark_plan_reverted`, `0023_copilot_applied_plans.sql`) atomically
  with its own audit entry.
- **Migration `0023_copilot_applied_plans.sql`.** New
  `copilot_applied_plans` table (one row per applied diff, including
  reverts) + `log_plan_diff_applied`/`mark_plan_reverted` RPCs. `0019`'s
  legacy `Plan`/`log_plan_applied` path is untouched.
- **Routes** (`apps/api/src/routes/workflows.ts`): `POST
  /:id/plan/apply-diff`, `GET /:id/plan/applied`, `POST
  /:id/plan/applied/:planId/revert` — same `workflows.updateDefinition`
  capability gate as the existing plan routes.
- **Web:** ghost preview renders diff ops (removed nodes/steps dimmed
  and marked, updated ones badged) via `ghostMapping.ts`'s
  `planDiffToGhostFlow`, merged onto real nodes/edges in
  `FlowCanvas.tsx` without touching `useNodesState`/`useEdgesState`
  (so autosave never sees ghost data). `CommandBar.tsx` gained a plain
  "Applied changes" list with a Revert button per plan and an inline
  conflict list on refusal, per the plan's "keep it plain."

## Bugs found

None in the new diff-apply code itself. Two environment/process issues
surfaced while running `copilot.spec.ts` (see Verification) — not
Phase 12 regressions, since Phase 12 never touches the propose/LLM
path, but worth recording since they cost real diagnosis time:

1. `apps/worker` (BullMQ consumer for `plan_propose` jobs) wasn't
   running in this session; the propose endpoint delegates to it via a
   synchronous queue wait (`planQueue.ts`) with no consumer, so
   requests hung until the wait's own timeout, surfacing to Playwright
   as a proxy `socket hang up`/`ECONNRESET`. Initially misdiagnosed as
   a missing LLM API key (grepped `apps/api/.env` for known provider
   key names and found nothing) — that grep was a red herring; the
   actual LLM credentials live in `apps/worker/.env`
   (`NIA_GATEWAY_*`), and once the worker was started the propose call
   completed in ~5s.
2. `canvasC` (org-less persona) had zero seeded connections in this
   local dev DB, causing the LLM to correctly return a "no connections"
   clarify-style outcome instead of a plan — not a hang, a legitimate
   response to genuinely missing data. `apps/web/e2e/README.md`
   documents that connections come from `pnpm --filter @nia/worker
   bootstrap` (a Vault RPC, not `seed.sql`), which hadn't been run in
   this environment. Running it seeded `canvasC`'s mysql connection;
   the spec then passed clean.

## Deviations from the plan, with reasons

- New `log_plan_diff_applied` RPC instead of reusing `0019`'s
  `log_plan_applied` — that RPC's `p_applied_node_ids uuid[]` shape
  only fits an add-only `Plan`; a `PlanDiff` touches nodes, edges, and
  steps, so the new RPC records the applied-row id + op-kind list
  instead.
- No RLS probes added to `supabase/tests/rls_probes.sql` for
  `copilot_applied_plans` — both its policies reduce to the same
  `private.can_access_workflow(workflow_id)` helper every other
  workflow-scoped table already has probes for.
- `planDiff.test.ts` (5 cases) and `copilotDiffApply.test.ts` (6
  cases) both exceed the plan's literal minimum — extra cases cover
  step-level ops round-tripping through `invertDiff`/
  `checkRevertConflicts` and a double-revert-refused case. Same
  engine, same contract, not scope creep.

## Open risks

- **Phase 13 dependency, not yet exercised:** nothing in Copilot's
  propose path emits a `PlanDiff` yet — this whole engine is
  exercised today only by `copilotDiffApply.test.ts` and direct route
  calls, not by a live LLM-authored diff. First real exercise is
  Phase 13's specialists.
- **Ghost-diff UI (removed/updated badges) has no e2e coverage** —
  `copilot.spec.ts` only exercises the legacy add-only `Plan` ghost
  path end-to-end; the new diff ghost overlay
  (`planDiffToGhostFlow`/`ghostDiffOverlay` in `FlowCanvas.tsx`) is
  typechecked and manually reasoned through but not covered by a
  running Playwright test, since nothing can propose a diff yet to
  drive one.
- **`canvasC`'s local dev connection was just (re-)seeded this
  session** via `pnpm --filter @nia/worker bootstrap` — worth keeping
  in mind if this local DB is reset without re-running that step.

## Verification

- Typecheck: `@nia/schemas`, `@nia/api`, `@nia/web` all clean.
- Unit tests, no regressions: `@nia/schemas` 530/530 (22 files, incl.
  `planDiff.test.ts` 5/5); `@nia/api` 34/34 (10 files, incl.
  `copilotDiffApply.test.ts` 6/6).
- `e2e/copilot.spec.ts` 6/6 (4 persona-login setup + both
  propose -> ghost -> apply flows), run against the unchanged legacy
  `Plan` path — confirms this phase's `putWorkflowGraph`/
  `ensureGraphStepIds` additions didn't regress it. Required starting
  `apps/api`, `apps/worker`, and local Supabase (all were down at the
  start of this session) and seeding connections via `pnpm --filter
  @nia/worker bootstrap` (see Bugs found).
- Not committed — per the plan's explicit instruction.

## git status --porcelain (untruncated)

```
 M apps/api/src/routes/workflows.ts
 M apps/web/src/components/canvas/CommandBar.tsx
 M apps/web/src/components/canvas/CopilotSidebar.tsx
 M apps/web/src/components/canvas/FlowCanvas.tsx
 M apps/web/src/components/canvas/GraphFlowNode.tsx
 M apps/web/src/components/canvas/styles.ts
 M apps/web/src/lib/api/copilotClient.ts
 M apps/web/src/lib/canvas/ghostMapping.ts
 M apps/web/src/lib/canvas/mapping.ts
 M apps/web/src/lib/canvas/store.ts
 M packages/schemas/src/index.ts
 M packages/schemas/src/nodeConfig.ts
?? PHASE12_EXIT.md
?? apps/api/src/services/copilotDiffApply.test.ts
?? apps/api/src/services/copilotDiffApply.ts
?? docs/plans/phase12.md
?? packages/schemas/src/planDiff.test.ts
?? packages/schemas/src/planDiff.ts
?? supabase/migrations/0023_copilot_applied_plans.sql
```

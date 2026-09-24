import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { GraphDoc, Plan, PlanDiff, CleanBindingInput } from "@nia/schemas";
import { requireAuth } from "../middleware/auth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { getWorkflowDetail } from "../services/workflows.js";
import { getWorkflowGraph, putWorkflowGraph } from "../services/workflowGraphs.js";
import { applyPlan } from "../services/copilotApply.js";
import { applyPlanDiff, listAppliedPlans, revertPlan } from "../services/copilotDiffApply.js";
import { proposePlanForWorkflow } from "../services/copilotPropose.js";
import { getLatestCheckRun, listCheckRuns, runAndRecordChecks } from "../services/checks.js";
import { proposeMappingForWorkflow } from "../services/mappings.js";
import { proposeCleaningForWorkflow } from "../services/cleanPropose.js";
import { previewWorkflowDestination } from "../services/preview.js";
import { getLatestConversationForWorkflow, listMessages } from "../services/chat.js";

export const workflowsRouter: ExpressRouter = Router();

workflowsRouter.use(requireAuth, attachDb, attachActor);

const workflowParamsSchema = z.object({ id: z.string().uuid() });

workflowsRouter.get(
  "/:id",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getWorkflowDetail(req.withUser, req.params.id!, scopeFromActor(req.actor));
    if (!data) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
    res.json(data);
  }),
);

// Builder canvas persistence (0012_workflow_graphs.sql). Version 0 is the
// "never saved" sentinel — see services/workflowGraphs.ts.
workflowsRouter.get(
  "/:id/graph",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getWorkflowGraph(req.withUser, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

const putGraphBodySchema = z.object({
  graph: GraphDoc,
  expectedVersion: z.number().int().nonnegative(),
});

workflowsRouter.put(
  "/:id/graph",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: putGraphBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await putWorkflowGraph(req.withUser, scopeFromActor(req.actor), req.params.id!, req.body);
    res.json(data);
  }),
);

const proposePlanBodySchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

// Phase 7 Session 3 — Copilot "propose". Gated the same as
// /mappings/propose and /plan/apply (workflows.updateDefinition, not
// workflows.run): a proposal is a config-editing assist, nothing is
// persisted until Apply. Always 200 — refused/clarify/no-connection/error
// are legitimate PlanProposeOutcome statuses the UI must render distinctly,
// not HTTP-level failures; only genuine infra failure (worker unreachable,
// malformed worker response, workflow/conversation not found) throws via
// AppError. See services/copilotPropose.ts's header comment for why this
// is a plain request/response route, not SSE, despite the original plan
// doc's Session 3 wording assuming otherwise.
workflowsRouter.post(
  "/:id/plan",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: proposePlanBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await proposePlanForWorkflow(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.id!,
      req.actor.userId,
      req.body.message,
      req.body.conversationId,
    );
    res.json(data);
  }),
);

const applyPlanBodySchema = z.object({
  plan: Plan,
  prompt: z.string().optional().default(""),
});

// Phase 7 Session 2.2 — Copilot "Apply". Same capability as PUT /:id/graph
// (this route is, structurally, still just a graph write — see
// copilotApply.ts's header comment) and no new authorization check of its
// own: req.supabase is the RLS-scoped client putWorkflowGraph() writes
// through, exactly like the plain PUT route above.
workflowsRouter.post(
  "/:id/plan/apply",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: applyPlanBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await applyPlan(req.withUser, scopeFromActor(req.actor), req.params.id!, req.body);
    res.json(data);
  }),
);

const applyPlanDiffBodySchema = z.object({
  diff: PlanDiff,
  prompt: z.string().optional(),
  // Phase 13 Step 6/7 — present only when this apply is the tail end of the
  // "Propose cleaning" flow (copilotDiffApply.ts's applyPlanDiff upserts a
  // clean_plans row iff this is set; an ordinary Copilot diff apply omits
  // it entirely).
  cleanBinding: z.object({ nodeId: z.string() }).merge(CleanBindingInput).optional(),
});

// Phase 12 — diff-based Copilot apply/revert, parallel to the Phase 7
// add-only /plan/apply route above (that route and copilotApply.ts are
// deliberately untouched; this is a new path, not a replacement). Same
// capability gate as every other config-editing route in this file
// (workflows.updateDefinition).
workflowsRouter.post(
  "/:id/plan/apply-diff",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: applyPlanDiffBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await applyPlanDiff(req.withUser, scopeFromActor(req.actor), req.params.id!, req.body);
    res.json(data);
  }),
);

const proposeCleaningBodySchema = z.object({ nodeId: z.string().min(1) });

// "Propose cleaning" (Phase 13, Step 7). Gated the same as mappings/propose
// (workflows.updateDefinition, not workflows.run) — a config-editing assist
// for the drawer, not a workflow execution. No persistence step of its own
// (services/cleanPropose.ts's header comment): the returned proposal is
// only ever bound once the user applies it via the existing
// /plan/apply-diff route's optional `cleanBinding` field.
workflowsRouter.post(
  "/:id/clean/propose",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: proposeCleaningBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await proposeCleaningForWorkflow(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.nodeId,
      req.actor.userId,
    );
    res.status(201).json(data);
  }),
);

// History of applied/reverted Copilot diffs for this workflow (Revert UI +
// Logs-tab style activity). Read-only, no capability gate beyond auth —
// same pattern as GET /:id/checks.
workflowsRouter.get(
  "/:id/plan/applied",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listAppliedPlans(req.withUser, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

const revertPlanParamsSchema = z.object({ id: z.string().uuid(), planId: z.string().uuid() });
const revertPlanBodySchema = z.object({ prompt: z.string().optional() });

// Reverts a previously-applied diff via its inverse (services/
// copilotDiffApply.ts's revertPlan header comment) — 409 REVERT_CONFLICT
// with a `conflicts` list in the error body when a touched element has
// drifted since apply; the UI renders that list rather than a generic
// error.
workflowsRouter.post(
  "/:id/plan/applied/:planId/revert",
  requireCapability("workflows.updateDefinition"),
  validate({ params: revertPlanParamsSchema, body: revertPlanBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await revertPlan(req.withUser, scopeFromActor(req.actor), req.params.id!, req.params.planId!, req.body);
    res.json(data);
  }),
);

// Checks (0014_workflow_check_runs.sql). POST runs the full check suite via
// the worker and persists the outcome through req.supabase's own
// record_check_run RPC call (see services/checks.ts's header comment on why
// that split is mandatory, not stylistic). GET reads back the latest
// persisted run without re-running anything, for the canvas to restore
// check/Run-gating state on load without forcing a fresh run.
workflowsRouter.post(
  "/:id/checks",
  requireCapability("workflows.run"),
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await runAndRecordChecks(req.withUser, scopeFromActor(req.actor), req.params.id!, req.actor.userId);
    res.status(201).json(data);
  }),
);

workflowsRouter.get(
  "/:id/checks/latest",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getLatestCheckRun(req.withUser, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

// Full check-run history (Logs tab, Phase 5 Session 4) — distinct from
// /checks/latest's single-row read.
workflowsRouter.get(
  "/:id/checks",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listCheckRuns(req.withUser, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

// Restores a workflow's chat thread on reload (canvas command bar, Phase 5
// Session 4) — the read side of 0015_conversation_workflow_link.sql. `null`
// when no conversation has ever been linked to this workflow.
workflowsRouter.get(
  "/:id/conversation",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const scope = scopeFromActor(req.actor);
    const conversation = await getLatestConversationForWorkflow(req.withUser, scope, req.params.id!);
    if (!conversation) {
      res.json(null);
      return;
    }
    const messages = await listMessages(req.withUser, scope, conversation.id);
    res.json({ conversation, messages });
  }),
);

const proposeMappingBodySchema = z.object({ destNodeId: z.string().min(1) });

// AI-proposed field mappings (Task 3). Gated the same as PUT /:id/graph
// (workflows.updateDefinition, not workflows.run) — this is a config-editing
// assist, not a workflow execution. Deliberately has NO persistence step of
// its own (services/mappings.ts's header comment): the returned proposal is
// only ever stored once the user explicitly approves it via the ordinary
// PUT /:id/graph call.
workflowsRouter.post(
  "/:id/mappings/propose",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: proposeMappingBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await proposeMappingForWorkflow(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.destNodeId,
      req.actor.userId,
    );
    res.status(201).json(data);
  }),
);

const previewBodySchema = z.object({ destNodeId: z.string().min(1) });

// Destination-node read preview (Block 1, Phase 5 Session 5). Gated the same
// as mappings/propose (workflows.updateDefinition, not workflows.run) — a
// preview is a config-editing assist for the drawer, not a workflow
// execution. Read-only end to end: the worker asserts the compiled query is
// read-shaped before it ever dispatches (runPreview.ts), and this route has
// no persistence step of its own (services/preview.ts's header comment).
workflowsRouter.post(
  "/:id/preview",
  requireCapability("workflows.updateDefinition"),
  validate({ params: workflowParamsSchema, body: previewBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await previewWorkflowDestination(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.destNodeId,
      req.actor.userId,
    );
    res.status(201).json(data);
  }),
);

// POST /:id/run and GET /:id/run/stream (Phase 6 Block 3) live in
// routes/runs.ts, not here — the stream side is consumed via a browser
// EventSource, which can never attach a Bearer Authorization header, only
// same-origin cookies, so both routes are cookie-authenticated (mirroring
// chat.ts's split from this Bearer-only router) rather than gated by this
// router's requireAuth.

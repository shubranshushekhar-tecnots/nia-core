import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { GraphDoc } from "@nia/schemas";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { getWorkflowDetail } from "../services/workflows.js";
import { getWorkflowGraph, putWorkflowGraph } from "../services/workflowGraphs.js";
import { getLatestCheckRun, listCheckRuns, runAndRecordChecks } from "../services/checks.js";
import { proposeMappingForWorkflow } from "../services/mappings.js";
import { getLatestConversationForWorkflow, listMessages } from "../services/chat.js";

export const workflowsRouter: ExpressRouter = Router();

workflowsRouter.use(requireAuth, attachActor);

const workflowParamsSchema = z.object({ id: z.string().uuid() });

workflowsRouter.get(
  "/:id",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getWorkflowDetail(req.supabase, req.params.id!, scopeFromActor(req.actor));
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
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getWorkflowGraph(req.supabase, scopeFromActor(req.actor), req.params.id!);
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
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await putWorkflowGraph(req.supabase, scopeFromActor(req.actor), req.params.id!, req.body);
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
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await runAndRecordChecks(req.supabase, scopeFromActor(req.actor), req.params.id!, req.actor.userId);
    res.status(201).json(data);
  }),
);

workflowsRouter.get(
  "/:id/checks/latest",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getLatestCheckRun(req.supabase, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

// Full check-run history (Logs tab, Phase 5 Session 4) — distinct from
// /checks/latest's single-row read.
workflowsRouter.get(
  "/:id/checks",
  validate({ params: workflowParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listCheckRuns(req.supabase, scopeFromActor(req.actor), req.params.id!);
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
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const scope = scopeFromActor(req.actor);
    const conversation = await getLatestConversationForWorkflow(req.supabase, scope, req.params.id!);
    if (!conversation) {
      res.json(null);
      return;
    }
    const messages = await listMessages(req.supabase, scope, conversation.id);
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
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await proposeMappingForWorkflow(
      req.supabase,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.destNodeId,
      req.actor.userId,
    );
    res.status(201).json(data);
  }),
);

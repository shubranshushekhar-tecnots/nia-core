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

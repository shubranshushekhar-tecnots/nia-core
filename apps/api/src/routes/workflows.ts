import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { getWorkflowDetail } from "../services/workflows.js";

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

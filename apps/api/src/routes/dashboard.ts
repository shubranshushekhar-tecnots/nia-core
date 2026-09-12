import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { getContinueWorkflow, getDashboardStats, getRecentRuns } from "../services/dashboard.js";

export const dashboardRouter: ExpressRouter = Router();

dashboardRouter.use(requireAuth, attachActor);

dashboardRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getDashboardStats(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

dashboardRouter.get(
  "/continue",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getContinueWorkflow(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

const recentRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

dashboardRouter.get(
  "/recent-runs",
  validate({ query: recentRunsQuerySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const limit = req.query.limit as number | undefined;
    const data = await getRecentRuns(req.supabase, scopeFromActor(req.actor), limit);
    res.json(data);
  }),
);

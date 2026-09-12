import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { getProjectDetail, getProjectsList, getSidebarProjects } from "../services/projects.js";

/**
 * No requireCapability here — these are plain reads, scoped by RLS via the
 * caller's own JWT exactly as apps/web's Server Components did. Nothing in
 * the source capability matrix ever gated reads (only org.view exists, and
 * it's granted to every role); mutations are what Step 3/the capability
 * matrix proposal add checks for.
 */
export const projectsRouter: ExpressRouter = Router();

projectsRouter.use(requireAuth, attachActor);

projectsRouter.get(
  "/sidebar",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getSidebarProjects(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getProjectsList(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

const projectParamsSchema = z.object({ id: z.string().uuid() });

projectsRouter.get(
  "/:id",
  validate({ params: projectParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getProjectDetail(req.supabase, req.params.id!, scopeFromActor(req.actor));
    if (!data) throw new AppError(404, "NOT_FOUND", "Project not found.");
    res.json(data);
  }),
);

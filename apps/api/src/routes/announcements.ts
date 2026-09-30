import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { getActiveAnnouncements, dismissAnnouncement } from "../services/announcements.js";

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). Customer-facing counterpart to consoleRouter's staff-only
 * /console/announcements routes — plain reads/writes scoped by RLS via the
 * caller's own JWT, same requireAuth/attachDb/attachActor chain as
 * dashboardRouter/projectsRouter, not requireStaff.
 */
export const announcementsRouter: ExpressRouter = Router();

announcementsRouter.use(requireAuth, attachDb, attachActor);

announcementsRouter.get(
  "/active",
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const announcements = await getActiveAnnouncements(req.withUser, req.actor.userId);
    res.json({ announcements });
  }),
);

const dismissParamsSchema = z.object({ id: z.string().uuid() });

announcementsRouter.post(
  "/:id/dismiss",
  validate({ params: dismissParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    try {
      await dismissAnnouncement(req.withUser, req.actor.userId, req.params.id!);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42501") throw new AppError(403, "FORBIDDEN", "This announcement can't be dismissed.");
      throw err;
    }
    res.json({ status: "ok" });
  }),
);

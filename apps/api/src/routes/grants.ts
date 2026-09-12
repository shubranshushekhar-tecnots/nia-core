import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { listWriteGrants, createWriteGrant, revokeWriteGrant } from "../services/grants.js";

// Mounted at /connections/:connectionId/grants — grants have no scope of
// their own (0007_connectors.sql), they inherit it entirely from the
// parent connection.
export const grantsRouter: ExpressRouter = Router({ mergeParams: true });

grantsRouter.use(requireAuth, attachActor);

const connectionParamsSchema = z.object({ connectionId: z.string().uuid() });

grantsRouter.get(
  "/",
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listWriteGrants(req.supabase, scopeFromActor(req.actor), req.params.connectionId!);
    res.json(data);
  }),
);

const createBodySchema = z.object({ scope: z.record(z.string(), z.unknown()).default({}) });

grantsRouter.post(
  "/",
  requireCapability("grants.create"),
  validate({ params: connectionParamsSchema, body: createBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await createWriteGrant(
      req.supabase,
      scopeFromActor(req.actor),
      req.params.connectionId!,
      req.actor.userId,
      req.body.scope,
    );
    res.status(201).json(data);
  }),
);

const grantParamsSchema = connectionParamsSchema.extend({ grantId: z.string().uuid() });

grantsRouter.delete(
  "/:grantId",
  requireCapability("grants.revoke"),
  validate({ params: grantParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await revokeWriteGrant(req.supabase, scopeFromActor(req.actor), req.params.connectionId!, req.params.grantId!);
    res.json(data);
  }),
);

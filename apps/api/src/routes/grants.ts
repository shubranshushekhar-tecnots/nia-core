import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { listWriteGrants, createWriteGrant, confirmWriteGrant, revokeWriteGrant } from "../services/grants.js";

// Mounted at /connections/:connectionId/grants — grants have no scope of
// their own (0007_connectors.sql), they inherit it entirely from the
// parent connection.
export const grantsRouter: ExpressRouter = Router({ mergeParams: true });

grantsRouter.use(requireAuth, attachDb, attachActor);

const connectionParamsSchema = z.object({ connectionId: z.string().uuid() });

grantsRouter.get(
  "/",
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listWriteGrants(req.withUser, scopeFromActor(req.actor), req.params.connectionId!);
    res.json(data);
  }),
);

const createBodySchema = z.object({ scope: z.record(z.string(), z.unknown()).default({}) });

grantsRouter.post(
  "/",
  requireCapability("grants.create"),
  validate({ params: connectionParamsSchema, body: createBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await createWriteGrant(req.withUser, scopeFromActor(req.actor), req.params.connectionId!, req.body.scope);
    res.status(201).json(data);
  }),
);

const grantParamsSchema = connectionParamsSchema.extend({ grantId: z.string().uuid() });

// Phase 6 Block 2/5 — the second step of the two-step grant model
// (0016_write_grants.sql): takes the raw write credential (the same
// user/password the client just showed the user in the generated
// CREATE ROLE/GRANT statement), stores it in Vault server-side, and
// attaches the resulting ref — unlocking the connector /write path +
// checkGrants for this grant's scope. Reuses grants.create's capability
// (same DECISION-C bucket: any role can mint or complete a grant it's
// already allowed to create).
const confirmBodySchema = z.object({ credential: z.object({ user: z.string().min(1), password: z.string().min(1) }) });

grantsRouter.post(
  "/:grantId/confirm",
  requireCapability("grants.confirm"),
  validate({ params: grantParamsSchema, body: confirmBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await confirmWriteGrant(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.connectionId!,
      req.params.grantId!,
      req.body.credential,
    );
    res.json(data);
  }),
);

grantsRouter.delete(
  "/:grantId",
  requireCapability("grants.revoke"),
  validate({ params: grantParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await revokeWriteGrant(req.withUser, scopeFromActor(req.actor), req.params.connectionId!, req.params.grantId!);
    res.json(data);
  }),
);

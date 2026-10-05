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
import { listAgents, createPairingCode, revokeAgent } from "../services/agents.js";

// Mounted at /agents — docs/plans/agent-canvas-integration.md B.1/B.3.
export const agentsRouter: ExpressRouter = Router();

agentsRouter.use(requireAuth, attachDb, attachActor);

agentsRouter.get(
  "/",
  requireCapability("agents.view"),
  asyncHandler(async (req, res) => {
    if (!req.withUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res.json(await listAgents(req.withUser));
  }),
);

agentsRouter.post(
  "/pair",
  requireCapability("agents.pair"),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res.status(201).json(await createPairingCode(req.withUser, scopeFromActor(req.actor)));
  }),
);

const agentParamsSchema = z.object({ agentId: z.string().uuid() });

// No requireCapability here (deliberately): the "pairing member may also
// revoke" exception (B.1) can't be expressed as a flat matrix check —
// revokeAgent() itself calls assertCanManageAgent after fetching the row,
// mirroring apps/web/src/lib/members/actions.ts's direct
// assertCanManageMember call rather than a flat middleware gate.
agentsRouter.delete(
  "/:agentId",
  validate({ params: agentParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res.json(await revokeAgent(req.withUser, req.actor.role, req.actor.userId, req.params.agentId!));
  }),
);

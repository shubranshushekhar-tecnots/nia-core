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
import {
  listAgents,
  createPairingCode,
  revokeAgent,
  listAgentSetups,
  listAgentConnections,
} from "../services/agents.js";

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

const pairBodySchema = z.object({ name: z.string().trim().min(1).max(120).optional() });

agentsRouter.post(
  "/pair",
  requireCapability("agents.pair"),
  validate({ body: pairBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res
      .status(201)
      .json(await createPairingCode(req.withUser, scopeFromActor(req.actor), req.body.name));
  }),
);

const agentParamsSchema = z.object({ agentId: z.string().uuid() });

// Slice L4 (B.11) — read-only; "agents.view" (same capability as the list
// above) already covers viewers, no new capability needed.
agentsRouter.get(
  "/:agentId/setups",
  requireCapability("agents.view"),
  validate({ params: agentParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res.json(await listAgentSetups(req.withUser, req.params.agentId!));
  }),
);

// Slice C1 — the agent's self-reported local connections, used by the web
// picker when creating a `sqlserver_agent` connection. Same posture as
// /:agentId/setups above: read-only, "agents.view" covers viewers.
agentsRouter.get(
  "/:agentId/connections",
  requireCapability("agents.view"),
  validate({ params: agentParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    res.json(await listAgentConnections(req.withUser, req.params.agentId!));
  }),
);

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

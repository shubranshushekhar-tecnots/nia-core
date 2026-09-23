import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import {
  getConnectorCatalog,
  installConnector,
  listConnectorInstalls,
  uninstallConnector,
} from "../services/connectors.js";

export const connectorsRouter: ExpressRouter = Router();

connectorsRouter.use(requireAuth, attachActor);

// Static manifest catalog — a read, ungated like every other read in this app.
connectorsRouter.get("/", (_req, res) => {
  res.json(getConnectorCatalog());
});

connectorsRouter.get(
  "/installs",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listConnectorInstalls(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

const installBodySchema = z.object({ connectorId: z.string().regex(/^[a-z0-9-]+$/) });

connectorsRouter.post(
  "/installs",
  requireCapability("connectors.install"),
  validate({ body: installBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await installConnector(
      req.supabase,
      scopeFromActor(req.actor),
      req.actor.userId,
      req.body.connectorId,
    );
    res.status(201).json(data);
  }),
);

const installParamsSchema = z.object({ id: z.string().uuid() });

connectorsRouter.delete(
  "/installs/:id",
  requireCapability("connectors.uninstall"),
  validate({ params: installParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    await uninstallConnector(req.supabase, scopeFromActor(req.actor), req.params.id!);
    res.status(204).end();
  }),
);

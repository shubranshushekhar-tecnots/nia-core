import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { EntityRef } from "@nia/schemas";
import { requireAuth } from "../middleware/auth.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  getConnectionSchema,
  refreshConnectionSchema,
  getConnectionProfile,
  refreshConnectionProfile,
  listConnectionUsages,
} from "../services/connections.js";

export const connectionsRouter: ExpressRouter = Router();

connectionsRouter.use(requireAuth, attachActor);

connectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listConnections(req.supabase, scopeFromActor(req.actor));
    res.json(data);
  }),
);

const connectionParamsSchema = z.object({ id: z.string().uuid() });

connectionsRouter.get(
  "/:id",
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getConnection(req.supabase, scopeFromActor(req.actor), req.params.id!);
    if (!data) throw new AppError(404, "NOT_FOUND", "Connection not found.");
    res.json(data);
  }),
);

const createBodySchema = z.object({
  connectorId: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
});

connectionsRouter.post(
  "/",
  requireCapability("connections.create"),
  validate({ body: createBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await createConnection(req.supabase, scopeFromActor(req.actor), req.actor.userId, req.body);
    res.status(201).json(data);
  }),
);

const updateBodySchema = z.object({
  displayName: z.string().min(1).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  confirmed: z.boolean().optional(),
});

connectionsRouter.patch(
  "/:id",
  requireCapability("connections.update"),
  validate({ params: connectionParamsSchema, body: updateBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await updateConnection(req.supabase, scopeFromActor(req.actor), req.params.id!, req.actor.userId, req.body);
    res.json(data);
  }),
);

const deleteQuerySchema = z.object({
  confirmed: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

connectionsRouter.delete(
  "/:id",
  requireCapability("connections.delete"),
  validate({ params: connectionParamsSchema, query: deleteQuerySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const confirmed = (req.query as unknown as z.infer<typeof deleteQuerySchema>).confirmed;
    await deleteConnection(req.supabase, scopeFromActor(req.actor), req.params.id!, req.actor.userId, confirmed);
    res.status(204).end();
  }),
);

connectionsRouter.get(
  "/:id/usages",
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await listConnectionUsages(req.supabase, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

connectionsRouter.post(
  "/:id/test",
  requireCapability("connections.test"),
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await testConnection(req.supabase, scopeFromActor(req.actor), req.params.id!, req.actor.userId);
    res.json(data);
  }),
);

connectionsRouter.get(
  "/:id/schema",
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getConnectionSchema(req.supabase, scopeFromActor(req.actor), req.params.id!);
    res.json(data);
  }),
);

// Reuses connections.test's capability grant: like /test, this hits an
// external system (a real /introspect call) and stays classified with
// create/update/delete/test rather than with reads — see can.ts's
// DECISION-C comment.
connectionsRouter.post(
  "/:id/schema/refresh",
  requireCapability("connections.test"),
  validate({ params: connectionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await refreshConnectionSchema(req.supabase, scopeFromActor(req.actor), req.params.id!, req.actor.userId);
    res.json(data);
  }),
);

const profileQuerySchema = EntityRef;

connectionsRouter.get(
  "/:id/profile",
  validate({ params: connectionParamsSchema, query: profileQuerySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const entity = req.query as unknown as z.infer<typeof EntityRef>;
    const data = await getConnectionProfile(req.supabase, scopeFromActor(req.actor), req.params.id!, entity, req.actor.userId);
    res.json(data);
  }),
);

// Same capability class as /schema/refresh: this triggers a real worker
// job that hits the external connector via dispatch() (up to ~10 sampling
// queries), not a plain read — see can.ts's DECISION-C comment.
connectionsRouter.post(
  "/:id/profile/refresh",
  requireCapability("connections.test"),
  validate({ params: connectionParamsSchema, body: EntityRef }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await refreshConnectionProfile(req.supabase, scopeFromActor(req.actor), req.params.id!, req.body, req.actor.userId);
    res.json(data);
  }),
);

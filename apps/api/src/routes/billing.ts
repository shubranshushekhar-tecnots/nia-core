import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { getUpgradePreview, createCheckout, getSubscriptionStatus } from "../services/billing.js";

/**
 * Subscription Phase 4, Slice 2. Authenticated routes only — the public,
 * signature-verified webhook route lives separately in billingWebhook.ts
 * (mounted before express.json() in index.ts, since it needs the raw body).
 */
export const billingRouter: ExpressRouter = Router();

billingRouter.use(requireAuth, attachDb, attachActor);

billingRouter.get(
  "/upgrade-preview",
  requireCapability("billing.view"),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getUpgradePreview(req.withUser, req.actor.userId);
    res.json(data);
  }),
);

const checkoutBodySchema = z.object({
  interval: z.enum(["monthly", "yearly"]),
});

billingRouter.post(
  "/checkout",
  requireCapability("billing.mutate"),
  validate({ body: checkoutBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    // Individual-only in this slice (see billing.ts's header comment) — an
    // org actor gets a clear 409 rather than silently checking out a
    // personal subscription that has nothing to do with their org.
    if (req.actor.org) {
      throw new AppError(409, "ORG_BILLING_NOT_SUPPORTED", "Organization checkout is not available yet.");
    }

    const data = await createCheckout(req.withUser, req.actor.userId, req.body.interval);
    res.status(201).json(data);
  }),
);

const subscriptionParamsSchema = z.object({ id: z.string().uuid() });

billingRouter.get(
  "/subscriptions/:id",
  requireCapability("billing.view"),
  validate({ params: subscriptionParamsSchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await getSubscriptionStatus(req.withUser, req.params.id!);
    if (!data) throw new AppError(404, "NOT_FOUND", "Subscription not found.");
    res.json(data);
  }),
);

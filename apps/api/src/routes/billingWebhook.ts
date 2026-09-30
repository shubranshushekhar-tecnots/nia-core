import { Router, type Router as ExpressRouter, type Request, type Response } from "express";
import { withServiceRole } from "@nia/db";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { verifyRazorpayWebhookSignature } from "../lib/razorpay.js";

/**
 * Subscription Phase 4, Slice 2 — public, no auth middleware at all (there
 * is no acting user: this is a server-to-server call from Razorpay, not a
 * browser session). Mounted in index.ts with express.raw() BEFORE the
 * global express.json() call, since signature verification (lib/razorpay.ts)
 * needs the exact, unparsed request bytes — re-serializing a parsed JSON
 * body would not reproduce Razorpay's own HMAC input byte-for-byte.
 *
 * withServiceRole here is the same "deliberate, narrow exception" to apps/
 * api's general never-withServiceRole rule (dbPool.ts's header comment)
 * requireStaff.ts already established: there is no acting user to run this
 * as, and the target RPC (apply_subscription_webhook,
 * 0065_subscription_webhook_rpc.sql) is itself locked down to
 * postgres/service_role only — not a general RLS bypass for ordinary
 * application reads/writes.
 *
 * Idempotency and out-of-order handling both live inside
 * apply_subscription_webhook() itself (processed_webhook_events insert +
 * last_webhook_event_at guard) — this route's only jobs are: verify the
 * signature, map Razorpay's event vocabulary to this schema's, and call the
 * RPC once.
 */
export const billingWebhookRouter: ExpressRouter = Router();

const EVENT_STATUS_MAP: Record<string, string> = {
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.halted": "past_due",
  "subscription.cancelled": "canceled",
};

type RazorpayWebhookPayload = {
  event: string;
  created_at: number;
  payload: {
    subscription?: {
      entity?: {
        id?: string;
        current_start?: number | null;
        current_end?: number | null;
      };
    };
    payment?: {
      entity?: {
        id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        invoice_id?: string | null;
      };
    };
  };
};

billingWebhookRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    // express.raw() (mounted in index.ts) gives a Buffer here, not a
    // parsed object — required for exact HMAC verification, see header
    // comment above.
    const rawBody = req.body as Buffer;
    const signature = req.header("x-razorpay-signature");
    const eventId = req.header("x-razorpay-event-id");

    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      throw new AppError(400, "INVALID_SIGNATURE", "Webhook signature verification failed.");
    }
    if (!eventId) {
      throw new AppError(400, "MISSING_EVENT_ID", "Missing x-razorpay-event-id header.");
    }

    let body: RazorpayWebhookPayload;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookPayload;
    } catch {
      throw new AppError(400, "INVALID_BODY", "Webhook body is not valid JSON.");
    }

    const mappedStatus = EVENT_STATUS_MAP[body.event];
    const subscriptionEntity = body.payload.subscription?.entity;
    const providerSubscriptionId = subscriptionEntity?.id;

    if (!mappedStatus || !providerSubscriptionId) {
      // A recognized-but-out-of-scope event (e.g. subscription.completed)
      // or a shape with nothing to act on — ack 200 so Razorpay doesn't
      // retry indefinitely, but never call the RPC (nothing to apply, and
      // nothing to log as processed either — a real event later still
      // gets its own fair idempotency check).
      res.status(200).json({ status: "ignored" });
      return;
    }

    const payment = body.payload.payment?.entity;
    const paymentJson = payment
      ? JSON.stringify({
          amountMinor: payment.amount ?? null,
          currency: payment.currency ?? null,
          providerPaymentId: payment.id ?? null,
          providerInvoiceId: payment.invoice_id ?? null,
          status: payment.status === "captured" ? "paid" : payment.status === "failed" ? "failed" : "pending",
        })
      : null;

    const result = await withServiceRole(dbPool, (db) =>
      db.query<{ apply_subscription_webhook: string }>(
        `select public.apply_subscription_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) as apply_subscription_webhook`,
        [
          "razorpay",
          eventId,
          body.event,
          new Date(body.created_at * 1000).toISOString(),
          providerSubscriptionId,
          mappedStatus,
          subscriptionEntity?.current_start ? new Date(subscriptionEntity.current_start * 1000).toISOString() : null,
          subscriptionEntity?.current_end ? new Date(subscriptionEntity.current_end * 1000).toISOString() : null,
          paymentJson,
        ],
      ),
    );

    res.status(200).json({ status: result.rows[0]?.apply_subscription_webhook ?? "unknown" });
  }),
);

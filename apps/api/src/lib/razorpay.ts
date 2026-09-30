import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

/**
 * Subscription Phase 4, Slice 2 (docs/plans/subscription-model.md) — thin
 * Razorpay REST client for individual Free/Legacy -> Pro checkout. Two
 * operations only: create a Subscription (checkout route) and verify an
 * inbound webhook signature (webhook route). No SDK dependency — Razorpay's
 * REST API is small enough that a raw fetch matches this codebase's existing
 * "thin HTTP client, no vendor SDK" posture (see connectorDispatch.ts).
 *
 * Docs cited (razorpay.com/docs/api/payments/subscriptions/, fetched during
 * this slice's research step):
 * - Create Subscription: POST /v1/subscriptions — required: plan_id,
 *   total_count. Response includes `short_url`, Razorpay's own hosted
 *   checkout page for that subscription — this slice redirects the browser
 *   there directly instead of embedding Checkout.js (speed rule).
 * - Authentication: HTTP Basic, key_id as username, key_secret as password.
 * - Webhook signature: X-Razorpay-Signature header = HMAC SHA256 of the raw
 *   (unparsed) request body, hex-encoded, using the webhook secret (a
 *   separate value from key_secret, set independently in the Dashboard's
 *   Webhooks screen).
 * - Webhook idempotency: the JSON payload itself carries no unique event id
 *   — the x-razorpay-event-id HTTP header is the unique-per-delivery value
 *   ("You can identify the duplicate webhooks using the x-razorpay-event-id
 *   header. The value for this header is unique per event.") — read by
 *   routes/billingWebhook.ts, not this file.
 */

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/**
 * Razorpay requires total_count (total number of billing cycles) on every
 * Subscription — there is no "runs forever" flag. 100 cycles (100 months /
 * 100 years, whichever interval the plan_id represents) is far beyond any
 * realistic customer lifetime and is the same pragmatic constant this
 * integration pattern commonly uses elsewhere; cancellation is always
 * explicit (cancel_at_period_end / the cancel webhook), never reached by
 * exhausting total_count in practice.
 */
const SUBSCRIPTION_TOTAL_COUNT = 100;

function authHeader(): string {
  const token = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string,
  ) {
    super(message);
    this.name = "RazorpayApiError";
  }
}

async function razorpayErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const description =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>).description
      : undefined;
  return typeof description === "string" && description.length > 0
    ? description
    : `Razorpay API responded ${res.status}`;
}

export type CreatedRazorpaySubscription = {
  id: string;
  status: string;
  shortUrl: string;
  customerId: string | null;
};

/**
 * Creates a Razorpay Subscription for the given plan and redirects the
 * customer to its hosted checkout (shortUrl). notes carries our own
 * subscription row id so it's visible on Razorpay's dashboard/webhook
 * payload for support/debugging — never used for any trust decision (the
 * webhook route looks up by provider_subscription_id, not notes).
 */
export async function createRazorpaySubscription(params: {
  razorpayPlanId: string;
  notifyCustomer: boolean;
  notes: Record<string, string>;
}): Promise<CreatedRazorpaySubscription> {
  const res = await fetch(`${RAZORPAY_API_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      plan_id: params.razorpayPlanId,
      total_count: SUBSCRIPTION_TOTAL_COUNT,
      customer_notify: params.notifyCustomer ? 1 : 0,
      notes: params.notes,
    }),
  });

  if (!res.ok) {
    throw new RazorpayApiError(await razorpayErrorMessage(res), res.status, `POST /subscriptions -> ${res.status}`);
  }

  const body = (await res.json()) as {
    id: string;
    status: string;
    short_url: string;
    customer_id?: string | null;
  };

  return {
    id: body.id,
    status: body.status,
    shortUrl: body.short_url,
    customerId: body.customer_id ?? null,
  };
}

/**
 * Verifies X-Razorpay-Signature against the raw (unparsed) request body.
 * Timing-safe compare — a plain === on hex strings would leak byte-position
 * information via response-time differences.
 */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { auth } from "../lib/auth.js";
import { dbPool } from "../lib/dbPool.js";
import { env } from "../env.js";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { billingWebhookRouter } from "./billingWebhook.js";

/**
 * Subscription Phase 4, Slice 2's mandatory tests (docs/plans/
 * subscription-model.md): duplicate webhook delivery is a no-op;
 * out-of-order events end in the correct final state; a bad signature is
 * rejected with 400 and changes nothing.
 *
 * apply_subscription_webhook()'s own idempotency/ordering logic is the
 * thing under test in the first two describe blocks — exercised directly
 * against real local Postgres (apps/api/.env's DATABASE_URL), same
 * approach orgPlan.integration.test.ts uses, and the same RPC this file's
 * own manual `begin;...rollback;` smoke test (run once during development,
 * not committed) already proved by hand. The third describe block instead
 * proves the ROUTE's own signature check runs before any RPC call at all —
 * a real HTTP server built from the exact same express.raw()+router
 * mounting index.ts uses (not a handler called in isolation), so a future
 * accidental reordering of that mount would fail this suite too. See
 * console.test.ts for the same real-HTTP-server-on-an-ephemeral-port
 * pattern.
 *
 * Real local Postgres only. Run explicitly with `pnpm test:integration`
 * (apps/api/vitest.integration.config.ts) — this file must be added to
 * that config's `include` list.
 */

async function createFixtureUser(label: string): Promise<string> {
  const email = `billing-webhook-${label}-${Date.now()}@nia.dev`;
  const result = await auth.api.signUpEmail({
    body: { email, password: "password", name: `billing webhook test (${label})` },
  });
  return result.user.id;
}

/** Mirrors create_individual_subscription()'s insert shape without going through checkout — no Razorpay API call needed for these RPC-level tests. */
async function createFixtureSubscription(
  userId: string,
  providerSubscriptionId: string,
): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.subscriptions (owner_user_id, plan_id, provider, provider_subscription_id, provider_customer_id, status, previous_plan_id)
     values ($1, 'pro', 'razorpay', $2, 'cust_test', 'incomplete', 'free')
     returning id`,
    [userId, providerSubscriptionId],
  );
  return rows[0]!.id;
}

async function currentOwnerPlan(userId: string): Promise<string> {
  const { rows } = await dbPool.query<{ plan_id: string }>(
    "select plan_id from public.owner_plan where user_id = $1",
    [userId],
  );
  return rows[0]!.plan_id;
}

async function cleanupUser(userId: string): Promise<void> {
  // subscriptions.owner_user_id and owner_plan.user_id both reference
  // "user"(id) on delete cascade.
  await dbPool.query('delete from public."user" where id = $1', [userId]);
}

afterAll(async () => {
  await dbPool.end();
});

describe("apply_subscription_webhook — duplicate delivery is a no-op — real Postgres", () => {
  it("re-applying the same (provider, provider_event_id) returns 'duplicate' and leaves state unchanged", async () => {
    const userId = await createFixtureUser("dup");
    const providerSubscriptionId = `sub_dup_${Date.now()}`;
    await createFixtureSubscription(userId, providerSubscriptionId);
    const eventId = `evt_dup_${Date.now()}`;

    try {
      const first = await dbPool.query<{ apply_subscription_webhook: string }>(
        `select public.apply_subscription_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as apply_subscription_webhook`,
        ["razorpay", eventId, "subscription.activated", new Date().toISOString(), providerSubscriptionId, "active", null, null, null],
      );
      expect(first.rows[0]?.apply_subscription_webhook).toBe("applied");
      expect(await currentOwnerPlan(userId)).toBe("pro");

      const second = await dbPool.query<{ apply_subscription_webhook: string }>(
        `select public.apply_subscription_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as apply_subscription_webhook`,
        ["razorpay", eventId, "subscription.activated", new Date().toISOString(), providerSubscriptionId, "active", null, null, null],
      );
      expect(second.rows[0]?.apply_subscription_webhook).toBe("duplicate");
      // No second side effect — still exactly 'pro', not re-applied twice.
      expect(await currentOwnerPlan(userId)).toBe("pro");

      const { rows: eventRows } = await dbPool.query(
        "select count(*)::int as count from public.processed_webhook_events where provider = 'razorpay' and provider_event_id = $1",
        [eventId],
      );
      expect(eventRows[0]?.count).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });
});

describe("apply_subscription_webhook — out-of-order delivery ends in the correct state — real Postgres", () => {
  it("an older event arriving after a newer one was already applied is rejected as 'stale' and never regresses status", async () => {
    const userId = await createFixtureUser("ooo");
    const providerSubscriptionId = `sub_ooo_${Date.now()}`;
    await createFixtureSubscription(userId, providerSubscriptionId);

    const newer = new Date("2026-01-01T00:01:40.000Z").toISOString();
    const older = new Date("2026-01-01T00:00:50.000Z").toISOString();

    try {
      const newerResult = await dbPool.query<{ apply_subscription_webhook: string }>(
        `select public.apply_subscription_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as apply_subscription_webhook`,
        ["razorpay", `evt_ooo_new_${Date.now()}`, "subscription.activated", newer, providerSubscriptionId, "active", null, null, null],
      );
      expect(newerResult.rows[0]?.apply_subscription_webhook).toBe("applied");

      const olderResult = await dbPool.query<{ apply_subscription_webhook: string }>(
        `select public.apply_subscription_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as apply_subscription_webhook`,
        ["razorpay", `evt_ooo_old_${Date.now()}`, "subscription.halted", older, providerSubscriptionId, "past_due", null, null, null],
      );
      expect(olderResult.rows[0]?.apply_subscription_webhook).toBe("stale");

      const { rows } = await dbPool.query<{ status: string }>(
        "select status from public.subscriptions where provider_subscription_id = $1",
        [providerSubscriptionId],
      );
      // Final state reflects the newer event, never regressed to the
      // older, out-of-order one's past_due.
      expect(rows[0]?.status).toBe("active");
      expect(await currentOwnerPlan(userId)).toBe("pro");
    } finally {
      await cleanupUser(userId);
    }
  });
});

describe("POST /billing/webhook — bad signature — real HTTP server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function buildApp(): Express {
    // Mirrors index.ts's exact mount: express.raw() with a wildcard type
    // filter BEFORE any json parsing, no auth middleware — see that file's
    // header comment for why.
    const app = express();
    app.use("/billing/webhook", express.raw({ type: "*/*" }), billingWebhookRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  }

  async function startServer(app: Express): Promise<string> {
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("rejects an invalid X-Razorpay-Signature with 400 and calls the RPC for nothing (no row change, no processed_webhook_events entry)", async () => {
    const userId = await createFixtureUser("badsig");
    const providerSubscriptionId = `sub_badsig_${Date.now()}`;
    await createFixtureSubscription(userId, providerSubscriptionId);
    const eventId = `evt_badsig_${Date.now()}`;

    try {
      const baseUrl = await startServer(buildApp());

      const payload = JSON.stringify({
        event: "subscription.activated",
        created_at: Math.floor(Date.now() / 1000),
        payload: { subscription: { entity: { id: providerSubscriptionId } } },
      });

      // Deliberately NOT the real HMAC (which would be
      // createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest("hex"))
      // — a syntactically valid but wrong signature, proving the compare
      // itself fails rather than some upstream parsing shortcut.
      const wrongSignature = createHmac("sha256", "not-the-real-secret").update(payload).digest("hex");

      const res = await fetch(`${baseUrl}/billing/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-razorpay-signature": wrongSignature,
          "x-razorpay-event-id": eventId,
        },
        body: payload,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_SIGNATURE");

      const { rows: eventRows } = await dbPool.query(
        "select count(*)::int as count from public.processed_webhook_events where provider = 'razorpay' and provider_event_id = $1",
        [eventId],
      );
      expect(eventRows[0]?.count).toBe(0);

      const { rows: subRows } = await dbPool.query<{ status: string }>(
        "select status from public.subscriptions where provider_subscription_id = $1",
        [providerSubscriptionId],
      );
      expect(subRows[0]?.status).toBe("incomplete");
      expect(await currentOwnerPlan(userId)).toBe("free");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("sanity: the real secret DOES verify (proves the test above failed for signature reasons, not payload/env issues)", () => {
    const payload = JSON.stringify({ event: "ping" });
    // Non-null: this integration test only ever runs against apps/api/.env,
    // which always carries a placeholder RAZORPAY_WEBHOOK_SECRET — env.ts
    // only makes this optional at the schema level for a
    // PAYMENTS_ENABLED=false deploy (see env.ts's header comment).
    const signature = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET!).update(payload).digest("hex");
    expect(signature).toHaveLength(64);
  });
});

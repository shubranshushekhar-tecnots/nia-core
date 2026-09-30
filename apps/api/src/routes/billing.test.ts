import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";

/**
 * Payments kill switch (env.PAYMENTS_ENABLED, docs/plans/subscription-model.md
 * Phase 4): billingRouter's own gate middleware runs before requireAuth, so
 * every route under it — checkout included — must 503 "Payments aren't
 * available yet" for a request with no auth at all, never a 401. Same
 * real-HTTP-server pattern as routes/console.test.ts; no DB/auth mocking
 * needed here since the gate short-circuits before either is ever touched.
 */
vi.mock("../env.js", () => ({ env: { PAYMENTS_ENABLED: false } }));

const { billingRouter } = await import("./billing.js");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/billing", billingRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function startServer(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("billingRouter — PAYMENTS_ENABLED=false", () => {
  it("POST /billing/checkout returns 503 PAYMENTS_DISABLED with no Authorization header at all", async () => {
    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval: "monthly" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("PAYMENTS_DISABLED");
  });

  it("GET /billing/subscriptions/:id returns 503 PAYMENTS_DISABLED, never reaching requireAuth's 401", async () => {
    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/billing/subscriptions/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("PAYMENTS_DISABLED");
  });
});

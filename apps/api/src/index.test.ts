import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Console v1 build order step 4 (docs/plans/console-plan.md §5), addendum
 * requested on review: genuinely exercise env.CONSOLE_ENABLED through the
 * REAL apps/api entry point (index.ts), not a hand-built substitute app —
 * that's routes/console.test.ts's job, which proves consoleRouter's own
 * requireAuth -> attachDb -> requireStaff chain works once mounted. This
 * file instead proves the literal `if (env.CONSOLE_ENABLED) { app.use("/console",
 * consoleRouter); }` line in index.ts actually gates mounting in the real
 * app, wired exactly as production boots it.
 *
 * index.ts has heavy module-load side effects that must be neutralized so
 * this needs no live Postgres/Redis and never binds the project's real
 * port:
 * - "@nia/db": createDbPool/withServiceRole/withActingUser stubbed — same
 *   convention as routes/console.test.ts and middleware/requireStaff.test.ts.
 * - "./lib/auth.js": auth.api.getSession stubbed — same convention, also
 *   avoids constructing a real Better Auth instance off the stubbed,
 *   valueless dbPool.
 * - "ioredis"/"bullmq": every apps/api Queue module (chatQueue, cleanQueue,
 *   checksQueue, mappingsQueue, planQueue, previewQueue, profileQueue,
 *   runQueue, schemaRefreshQueue — all transitively imported by index.ts)
 *   constructs a real `new Redis(...)` plus `new Queue(...)`/`new
 *   QueueEvents(...)` at module load. Stubbing both packages wholesale
 *   means none of those nine files needs its own separate mock.
 *
 * env.ts parses `process.env` once at module load (`export const env =
 * EnvSchema.parse(process.env)`), so CONSOLE_ENABLED can only differ
 * between the two cases below by stubbing process.env AND calling
 * vi.resetModules() before each dynamic re-import of the whole chain
 * (env.js -> index.js) — a plain top-level import would only ever see one
 * value for the entire file. PORT is likewise stubbed to a fixed,
 * test-only port (env.ts's schema requires a *positive* int, so "0" is
 * rejected — there is no "ask the OS for an ephemeral port" option here
 * without also exporting `app` separately from `app.listen()`, which
 * would be a bigger refactor than this addendum warrants).
 */

const TEST_PORT = "58734";

const getSession = vi.fn();
vi.mock("./lib/auth.js", () => ({ auth: { api: { getSession } } }));

const withServiceRole = vi.fn();
// Resolves { rows: [] } by default (not a bare vi.fn()): the "authenticated"
// variant of the flag-off test below must clear chatRouter's own
// attachActor, which calls withUser (a closure over withActingUser) twice
// and destructures `.rows` off each result — an unconfigured vi.fn()
// resolving to undefined would throw before this test ever reaches the 404
// it's actually about.
const withActingUser = vi.fn().mockResolvedValue({ rows: [] });
vi.mock("@nia/db", () => ({ withServiceRole, withActingUser, createDbPool: vi.fn() }));

// vi.fn()'s own mockImplementation must be a `function`/`class`, not an
// arrow, since every Queue module in apps/api/src/lib constructs these
// with `new` — an arrow-returned plain object throws "is not a
// constructor" the moment it's `new`'d.
class FakeRedis {
  on = vi.fn();
  quit = vi.fn();
  disconnect = vi.fn();
}
class FakeQueue {
  add = vi.fn();
  getJob = vi.fn();
  close = vi.fn();
}
class FakeQueueEvents {
  on = vi.fn();
  close = vi.fn();
}
vi.mock("ioredis", () => ({ Redis: FakeRedis }));
vi.mock("bullmq", () => ({ Queue: FakeQueue, QueueEvents: FakeQueueEvents }));

let server: Server | undefined;
// eslint-disable-next-line @typescript-eslint/ban-types -- matches process.listeners()'s own return type
let addedSigint: Function[] = [];
// eslint-disable-next-line @typescript-eslint/ban-types
let addedSigterm: Function[] = [];

async function bootApp(overrides: { consoleEnabled?: boolean; paymentsEnabled?: boolean } = {}): Promise<string> {
  if (overrides.consoleEnabled !== undefined) {
    vi.stubEnv("CONSOLE_ENABLED", overrides.consoleEnabled ? "true" : "false");
  }
  if (overrides.paymentsEnabled !== undefined) {
    vi.stubEnv("PAYMENTS_ENABLED", overrides.paymentsEnabled ? "true" : "false");
  }
  vi.stubEnv("PORT", TEST_PORT);
  vi.resetModules();

  // index.ts registers its own SIGINT/SIGTERM handlers as an import-time
  // side effect; diff before/after so afterEach can remove exactly the
  // ones this re-import added, instead of leaking listeners onto the real
  // test-runner process across the two cases in this file.
  const sigintBefore = process.listeners("SIGINT");
  const sigtermBefore = process.listeners("SIGTERM");

  const mod = await import("./index.js");
  server = mod.server;

  addedSigint = process.listeners("SIGINT").filter((l) => !sigintBefore.includes(l));
  addedSigterm = process.listeners("SIGTERM").filter((l) => !sigtermBefore.includes(l));

  await new Promise<void>((resolve, reject) => {
    if (server!.listening) {
      resolve();
      return;
    }
    server!.once("listening", resolve);
    server!.once("error", reject);
  });

  return `http://127.0.0.1:${TEST_PORT}`;
}

afterEach(async () => {
  getSession.mockReset();
  withServiceRole.mockReset();
  vi.unstubAllEnvs();
  for (const l of addedSigint) process.removeListener("SIGINT", l as NodeJS.SignalsListener);
  for (const l of addedSigterm) process.removeListener("SIGTERM", l as NodeJS.SignalsListener);
  addedSigint = [];
  addedSigterm = [];
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("index.ts CONSOLE_ENABLED gate (the real app, not a substitute)", () => {
  it("CONSOLE_ENABLED=false, authenticated: GET /console/ping 404s — consoleRouter is never mounted", async () => {
    // Must present a valid session cookie for this one: chatRouter is
    // mounted at "/" (a genuine prefix match for every path, per index.ts's
    // own header comment on that mount), so an UNAUTHENTICATED request to
    // "/console/ping" is actually intercepted by chatRouter's blanket
    // requireCookieAuth and 401s there — it never even reaches the point of
    // "no route matched" that produces this 404. Only a request that clears
    // requireCookieAuth falls through (no route inside chatRouter matches
    // "/console/ping" either) to index.ts's own final notFoundHandler,
    // which is the actual, specific thing this test needs to prove: that
    // consoleRouter itself was never mounted, not just that some earlier
    // gate happened to reject the request first.
    getSession.mockResolvedValue({
      response: { user: { id: "staff-1", email: "staff@nia.dev" } },
      headers: new Headers(),
    });
    const baseUrl = await bootApp({ consoleEnabled: false });
    const res = await fetch(`${baseUrl}/console/ping`, { headers: { cookie: "better-auth.session_token=x" } });

    expect(res.status).toBe(404);
  });

  it("CONSOLE_ENABLED=false, unauthenticated: GET /console/ping 401s from chatRouter's blanket auth, not consoleRouter", async () => {
    // The flip side of the above, stated as its own assertion so this
    // masking behavior is pinned down explicitly rather than left as an
    // implicit assumption: with the flag off and no cookie, the caller
    // never learns "/console" doesn't exist — they get the same generic
    // 401 any other unauthenticated request under "/" gets. requireCookieAuth
    // destructures `{ response, headers }` off the resolved value even with
    // no cookie present, so an un-configured vi.fn() (resolves to undefined)
    // would throw before ever reaching the 401 this test asserts.
    getSession.mockResolvedValue({ response: null, headers: new Headers() });
    const baseUrl = await bootApp({ consoleEnabled: false });
    const res = await fetch(`${baseUrl}/console/ping`);

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });

  it("CONSOLE_ENABLED=true: GET /console/ping reaches requireAuth — 401 without an auth header", async () => {
    const baseUrl = await bootApp({ consoleEnabled: true });
    const res = await fetch(`${baseUrl}/console/ping`);

    expect(res.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    expect(withServiceRole).not.toHaveBeenCalled();
  });
});

describe("index.ts PAYMENTS_ENABLED gate (the real app, not a substitute)", () => {
  it("PAYMENTS_ENABLED=false: POST /billing/webhook 404s — billingWebhookRouter is never mounted", async () => {
    const baseUrl = await bootApp({ paymentsEnabled: false });
    const res = await fetch(`${baseUrl}/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });

  it("PAYMENTS_ENABLED=true: POST /billing/webhook reaches billingWebhookRouter — 400 bad signature, not 404", async () => {
    // apps/api/.env always carries a placeholder RAZORPAY_WEBHOOK_SECRET
    // (env.ts's header comment), so this boots fine without also stubbing
    // the RAZORPAY_* vars — this test only needs to prove the route is
    // mounted, not exercise signature verification itself (that's
    // billingWebhook.integration.test.ts's job).
    const baseUrl = await bootApp({ paymentsEnabled: true });
    const res = await fetch(`${baseUrl}/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
  });
});

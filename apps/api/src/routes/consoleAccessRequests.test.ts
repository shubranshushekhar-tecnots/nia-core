import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";

/**
 * Email Phase 3 — Console "Access requests" API. Same harness convention
 * as console.test.ts: a real HTTP server, auth.api.getSession + withServiceRole
 * mocked at the module boundary, mounting the real consoleRouter (so
 * requireAuth -> attachDb -> requireStaff's own 401/403 gate is exercised
 * for real, not re-implemented here) — lean coverage per the plan: 403
 * non-staff, approve/reject write status + audit row + enqueue email, and
 * re-approving a previously-rejected row.
 */
const getSession = vi.fn();
vi.mock("../lib/auth.js", () => ({ auth: { api: { getSession } } }));

const STAFF_SESSION = {
  user: { id: "staff-1", email: "staff@nia.dev" },
  session: { twoFactorVerifiedAt: new Date(), createdAt: new Date() },
};

const withServiceRole = vi.fn();
vi.mock("@nia/db", () => ({ withServiceRole, withActingUser: vi.fn(), createDbPool: vi.fn() }));

const enqueueEmail = vi.fn();
vi.mock("../lib/mailQueue.js", () => ({ enqueueEmail }));

const queueGetWorkers = vi.fn();
const queueGetJobCounts = vi.fn();
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function Queue() {
    return { getWorkers: queueGetWorkers, getJobCounts: queueGetJobCounts };
  }),
}));
vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(function Redis() {}) }));

const { consoleRouter } = await import("./console.js");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/console", consoleRouter);
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
  getSession.mockReset();
  withServiceRole.mockReset();
  enqueueEmail.mockReset();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const ROW: {
  id: string;
  email: string;
  full_name: string;
  company: string;
  job_role: string | null;
  use_case: string;
  data_sources: string[];
  referral_source: string | null;
  status: "pending" | "approved" | "rejected";
  rejected_reason: string | null;
  plan_id: string | null;
  grant_plan_id: string | null;
  grant_expires_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  signed_up_user_id: string | null;
  created_at: string;
  updated_at: string;
} = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "requester@example.com",
  full_name: "Req Ester",
  company: "Acme",
  job_role: "Analyst",
  use_case: "ETL into our warehouse",
  data_sources: ["postgres"],
  referral_source: null,
  status: "pending",
  rejected_reason: null,
  plan_id: null,
  grant_plan_id: null,
  grant_expires_at: null,
  reviewed_by: null,
  reviewed_at: null,
  signed_up_user_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function mockDb(opts: { before?: Partial<typeof ROW>; after?: Partial<typeof ROW> }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("select status, email from public.access_requests")) {
      return opts.before ? { rows: [{ status: ROW.status, email: ROW.email, ...opts.before }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("update public.access_requests")) {
      return { rows: [{ ...ROW, ...opts.before, ...opts.after }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return query;
}

describe("GET /console/access-requests/pending-count", () => {
  it("returns the pending count for a staff session, without writing an audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("count(*)")) return { rows: [{ count: "3" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/pending-count`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("log_staff_action"))).toBe(false);
  });

  it("returns 403 for a non-staff session", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/pending-count`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(403);
  });
});

describe("PATCH /console/access-requests/:id/approve", () => {
  it("returns 403 for an authenticated non-staff session, without touching the row", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/${ROW.id}/approve`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("approves a pending request, writes an audit row, and emails accessRequestApproved", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockDb({ before: {}, after: { status: "approved" } });

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/${ROW.id}/approve`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("approved");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("private.log_staff_action"))).toBe(true);
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ROW.email, payload: expect.objectContaining({ template: "accessRequestApproved" }) }),
    );
  });

  it("re-approves a previously-rejected row (clears rejected_reason, flips status back to approved)", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    mockDb({ before: { status: "rejected", rejected_reason: "not a fit" }, after: { status: "approved", rejected_reason: null } });

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/${ROW.id}/approve`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.rejectedReason).toBeNull();
  });
});

describe("PATCH /console/access-requests/:id/reject", () => {
  it("rejects a pending request, writes an audit row, and emails accessRequestRejected", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockDb({ before: {}, after: { status: "rejected", rejected_reason: "not a fit" } });

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/${ROW.id}/reject`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "not a fit" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("rejected");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("private.log_staff_action"))).toBe(true);
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ROW.email, payload: expect.objectContaining({ template: "accessRequestRejected" }) }),
    );
  });

  it("404s for an unknown id, without emailing", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    mockDb({});

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/access-requests/${ROW.id}/reject`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});

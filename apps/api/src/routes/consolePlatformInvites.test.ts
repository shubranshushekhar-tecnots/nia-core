import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";

/**
 * Email Phase 3 — Console "Invitations" API. Same harness convention as
 * console.test.ts/consoleAccessRequests.test.ts. Lean coverage per the
 * plan: create/resend/revoke each write an audit row + the correct email
 * template, and list computes "expired" correctly from expires_at/status
 * rather than a stored flag.
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

const ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "invitee@example.com",
  name: "Invitee Name",
  status: "pending",
  note: null,
  plan_id: null,
  grant_plan_id: null,
  grant_expires_at: null,
  invited_by: "staff-1",
  expires_at: "2099-01-01T00:00:00.000Z",
  accepted_at: null,
  accepted_user_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("POST /console/platform-invites", () => {
  it("creates an invite, writes an audit row, and emails the platformInvite template", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("where lower(email) = lower($1) and status = 'pending'")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("insert into public.platform_invites")) return { rows: [ROW], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ email: ROW.email, name: ROW.name }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).email).toBe(ROW.email);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("private.log_staff_action"))).toBe(true);
    const emailCall = enqueueEmail.mock.calls[0]?.[0];
    expect(emailCall).toMatchObject({ to: ROW.email, payload: { template: "platformInvite" } });
    expect(emailCall.payload.data.acceptUrl).toMatch(/\/accept-invite\//);
  });

  it("409s when the email already has a pending invite", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("where lower(email) = lower($1) and status = 'pending'")) return { rows: [{ id: ROW.id }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ email: ROW.email }),
    });

    expect(res.status).toBe(409);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});

describe("POST /console/platform-invites/:id/resend", () => {
  it("mints a fresh token, bumps expires_at, writes an audit row, and re-emails", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("select status from public.platform_invites")) return { rows: [{ status: "pending" }], rowCount: 1 };
      if (sql.startsWith("update public.platform_invites")) return { rows: [ROW], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites/${ROW.id}/resend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("private.log_staff_action"))).toBe(true);
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ROW.email, payload: expect.objectContaining({ template: "platformInvite" }) }));
  });

  it("400s when the invite isn't pending (e.g. already revoked)", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("select status from public.platform_invites")) return { rows: [{ status: "revoked" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites/${ROW.id}/resend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(400);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});

describe("POST /console/platform-invites/:id/revoke", () => {
  it("revokes a pending invite and writes an audit row, without emailing", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("select status, email from public.platform_invites")) return { rows: [{ status: "pending", email: ROW.email }], rowCount: 1 };
      if (sql.startsWith("update public.platform_invites")) return { rows: [{ ...ROW, status: "revoked" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites/${ROW.id}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("revoked");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("private.log_staff_action"))).toBe(true);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});

describe("GET /console/platform-invites", () => {
  it("computes expired=true for a pending row whose expires_at is in the past", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const expiredRow = { ...ROW, status: "pending", expires_at: "2020-01-01T00:00:00.000Z" };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("count(*) as count")) return { rows: [{ count: "1" }], rowCount: 1 };
      return { rows: [expiredRow], rowCount: 1 };
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    const started = await startServer(buildApp());
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/platform-invites`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ status: "pending", expired: true });
  });
});

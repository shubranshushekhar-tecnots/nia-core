import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";

/**
 * Console v1 build order step 4 (docs/plans/console-plan.md §5): "Test:
 * staff session → 200; non-staff session → 403; flag off → router not
 * mounted at all." Runs against a real HTTP server (node:http + fetch)
 * rather than calling consoleRouter's handlers directly, so this exercises
 * the genuine requireAuth -> attachDb -> requireStaff -> route chain end to
 * end, same as a real client would hit it — not just each middleware in
 * isolation (that's requireStaff.test.ts's job).
 *
 * auth.api.getSession and withServiceRole are mocked at the module
 * boundary (same convention as requireStaff.test.ts/auth.test.ts) — both
 * are already-tested primitives this test isn't re-verifying.
 *
 * "Flag off -> router not mounted at all" is proven here by building the
 * app WITHOUT mounting consoleRouter and asserting GET /console/ping 404s —
 * genuinely exercising "importing consoleRouter registers nothing until
 * .use()'d", not index.ts's own two-line `if (env.CONSOLE_ENABLED)` guard
 * directly: index.ts has heavy module-load side effects (opens the real DB
 * pool, Redis queues, starts listening on env.PORT, registers every
 * copilot tool) that make it unsafe/impractical to import in a test, the
 * same reason no other route file in this suite imports it either.
 */
const getSession = vi.fn();
vi.mock("../lib/auth.js", () => ({ auth: { api: { getSession } } }));

// Slice 4 (§4b, decision 17): requireStaff makes its OWN auth.api.getSession()
// call (same mocked fn as requireAuth's) to read session.twoFactorVerifiedAt/
// createdAt — every "staff-1" mock below must carry a passing `session` too,
// not just `user`, or requireStaff's new 2FA/session-age gate 500s.
const STAFF_SESSION = {
  user: { id: "staff-1", email: "staff@nia.dev" },
  session: { twoFactorVerifiedAt: new Date(), createdAt: new Date() },
};

const withServiceRole = vi.fn();
// createDbPool is stubbed too: lib/dbPool.ts (imported transitively via
// both requireStaff.ts and middleware/db.ts) calls it at module load time
// to build the process pool.
vi.mock("@nia/db", () => ({ withServiceRole, withActingUser: vi.fn(), createDbPool: vi.fn() }));

const { consoleRouter } = await import("./console.js");

function buildApp(options: { mountConsole: boolean }): Express {
  const app = express();
  app.use(express.json());
  if (options.mountConsole) {
    app.use("/console", consoleRouter);
  }
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
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("GET /console/ping", () => {
  it("returns 200 for a session with an active platform_staff row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/ping`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 403 for an authenticated session with no active platform_staff row", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/ping`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NOT_STAFF");
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for a request with no Authorization header, without ever checking platform_staff", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/ping`);

    expect(res.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    expect(withServiceRole).not.toHaveBeenCalled();
  });

  it("404s when the router isn't mounted at all (the CONSOLE_ENABLED=false state)", async () => {
    const started = await startServer(buildApp({ mountConsole: false }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/ping`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(404);
    expect(getSession).not.toHaveBeenCalled();
    expect(withServiceRole).not.toHaveBeenCalled();
  });
});

/**
 * Build order step 5 / Slice 1: GET /console/orgs. requireStaff's own gate
 * (200/403/401/flag-off) is already covered above for the shared middleware
 * chain — these tests focus on what's new: the org-list query result shape
 * and the one staff_audit_log row per request (decision 4, console-plan.md
 * §5a). withServiceRole is mocked to hand the route a fake Queryable so the
 * two db.query calls inside it (the org list select, then the audit log
 * insert) can be asserted directly, without a real database.
 */
/**
 * Shared fake `db.query`: `withServiceRole` is mocked to hand the route a
 * fake Queryable, so both requireStaff's platform_staff check and the
 * route's own count/select/audit-log queries all run through this one
 * function and respond based on SQL text, not call order. `total` controls
 * what the count(*) query reports (default: as many rows as `orgRows`, i.e.
 * "no more pages" unless a test overrides it to prove `hasMore`).
 */
function mockOrgsQuery(orgRows: Record<string, string | null>[], total = orgRows.length) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("count(*) as count")) return { rows: [{ count: String(total) }], rowCount: 1 };
    return { rows: orgRows, rowCount: orgRows.length };
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return query;
}

describe("GET /console/orgs", () => {
  it("returns the mapped org list, total/hasMore, and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const orgRow = {
      id: "org-1",
      name: "Acme Inc",
      slug: "acme-inc",
      created_at: "2026-01-01T00:00:00.000Z",
      member_count: "3",
      runs_30d: "12",
      suspended_at: null,
    };
    const query = mockOrgsQuery([orgRow], 1);

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs?search=Acme`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgs: [
        {
          id: "org-1",
          name: "Acme Inc",
          slug: "acme-inc",
          planTier: "Pro",
          status: "Active",
          memberCount: 3,
          runs30d: 12,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    // Call 1 = requireStaff's own withServiceRole check; call 2 = the
    // route's own withServiceRole block (count + org list select + audit
    // log write).
    expect(withServiceRole).toHaveBeenCalledTimes(2);
    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual([
      "staff-1",
      "org.list",
      null,
      null,
      JSON.stringify({ search: "Acme", limit: 50, offset: 0, count: 1 }),
    ]);
  });

  /**
   * Slice 1 review fix: the directory must never silently truncate a
   * result set — `hasMore`/`total` must reflect the real server-side count
   * (5 here) even though only 2 rows come back on this page, so the
   * frontend knows there's more to load.
   */
  it("reports hasMore: true and the real total when more orgs exist than this page returned", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const orgRows = [
      { id: "org-1", name: "A", slug: "a", created_at: "2026-01-01T00:00:00.000Z", member_count: "1", runs_30d: "0" },
      { id: "org-2", name: "B", slug: "b", created_at: "2026-01-01T00:00:00.000Z", member_count: "1", runs_30d: "0" },
    ];
    mockOrgsQuery(orgRows, 5);

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs?limit=2`, {
      headers: { authorization: "Bearer good-token" },
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.hasMore).toBe(true);
    expect(body.orgs).toHaveLength(2);
  });

  it("passes offset through to the query and into the response", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const query = mockOrgsQuery([], 5);

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs?offset=2&limit=2`, {
      headers: { authorization: "Bearer good-token" },
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.offset).toBe(2);
    // offset (2) + rows returned (0, since orgRows is empty here) < total
    // (5) — still hasMore, proving hasMore is computed from offset, not
    // just "did this page come back empty".
    expect(body.hasMore).toBe(true);

    const orgSelectCall = query.mock.calls.find((call) => call[0].includes("left join public.organization_members"));
    expect(orgSelectCall?.[1]).toEqual(["", 2, 2]);
  });

  it("returns 403 for a non-staff session without ever querying orgs", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(403);
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for an unauthenticated request", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs`);

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });

  /**
   * Slice 1 review fix (docs/plans/console-plan.md): `limit` caps a single
   * request's rows, with a sensible default and a hard max — proven here
   * via the actual SQL params `withServiceRole`'s query() call receives,
   * same technique the audit-row assertion above already uses.
   */
  it("defaults limit to 50 and offset to 0 when the query string omits them", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const query = mockOrgsQuery([]);

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs`, { headers: { authorization: "Bearer good-token" } });

    expect(res.status).toBe(200);
    const orgSelectCall = query.mock.calls.find((call) => call[0].includes("left join public.organization_members"));
    expect(orgSelectCall?.[1]).toEqual(["", 50, 0]);
  });

  it("passes an explicit limit through to the query", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const query = mockOrgsQuery([]);

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs?limit=10`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    const orgSelectCall = query.mock.calls.find((call) => call[0].includes("left join public.organization_members"));
    expect(orgSelectCall?.[1]).toEqual(["", 10, 0]);
  });

  it("rejects a limit above the hard max (200) with a validation error, without querying orgs", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs?limit=201`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    // requireStaff's own platform_staff check (the router-level .use()) runs
    // before the route's validate() middleware can reject the query string,
    // so withServiceRole is still called once for that — this asserts the
    // route handler itself (the org list query + audit write) never runs.
    expect(withServiceRole).toHaveBeenCalledOnce();
  });
});

/**
 * Build order steps 6-7 / Slice 2 (console-plan.md §3, §5a decision 8):
 * GET /console/orgs/:orgId. requireStaff's own gate (200/403/401/flag-off)
 * is already covered by the /ping tests above for the shared middleware
 * chain — these tests focus on what's new: the org-detail response shape
 * (profile + plan/limits/usage + members), the 404-when-not-found case,
 * and the one staff_audit_log row per request (action 'org.read', org_id
 * set — distinct from GET /orgs's per-page 'org.list' exception).
 */
function mockOrgDetailQuery(options: {
  org: Record<string, unknown> | null;
  usageCount?: number;
  runs30d?: number;
  memberRows?: Record<string, string>[];
}) {
  const { org, usageCount = 0, runs30d = 0, memberRows = [] } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("from public.organizations o")) return { rows: org ? [org] : [], rowCount: org ? 1 : 0 };
    if (sql.includes("from public.workflows")) return { rows: [{ count: usageCount }], rowCount: 1 };
    if (sql.includes("from public.workflow_runs")) return { rows: [{ count: runs30d }], rowCount: 1 };
    if (sql.includes("organization_members om")) return { rows: memberRows, rowCount: memberRows.length };
    throw new Error(`mockOrgDetailQuery: unexpected SQL: ${sql}`);
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return query;
}

describe("GET /console/orgs/:orgId", () => {
  it("returns profile, plan/limits/usage, and members, and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const orgRow = {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme Inc",
      slug: "acme-inc",
      created_at: "2026-01-01T00:00:00.000Z",
      plan_tier: "Pro",
      workflow_limit: 25,
      suspended_at: null,
      suspended_reason: null,
      suspended_by: null,
      suspended_by_name: null,
    };
    const memberRow = {
      user_id: "user-1",
      name: "Ada Member",
      email: "ada@acme.test",
      role: "owner",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    const query = mockOrgDetailQuery({ org: orgRow, usageCount: 7, runs30d: 12, memberRows: [memberRow] });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/11111111-1111-1111-1111-111111111111`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme Inc",
      slug: "acme-inc",
      createdAt: "2026-01-01T00:00:00.000Z",
      planTier: "Pro",
      status: "Active",
      workflowLimit: 25,
      workflowsUsed: 7,
      runs30d: 12,
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      members: [
        { userId: "user-1", name: "Ada Member", email: "ada@acme.test", role: "owner", joinedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual(["staff-1", "org.read", null, "11111111-1111-1111-1111-111111111111", JSON.stringify({})]);
  });

  it("reports status: Suspended and the suspendedBy staffer when the org is suspended", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const orgRow = {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme Inc",
      slug: "acme-inc",
      created_at: "2026-01-01T00:00:00.000Z",
      plan_tier: "Pro",
      workflow_limit: 25,
      suspended_at: "2026-02-01T00:00:00.000Z",
      suspended_reason: "Non-payment",
      suspended_by: "staff-2",
      suspended_by_name: "Bob Staffer",
    };
    mockOrgDetailQuery({ org: orgRow, usageCount: 0, runs30d: 0, memberRows: [] });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/11111111-1111-1111-1111-111111111111`, {
      headers: { authorization: "Bearer good-token" },
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("Suspended");
    expect(body.suspendedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(body.suspendedReason).toBe("Non-payment");
    expect(body.suspendedBy).toEqual({ userId: "staff-2", name: "Bob Staffer" });
  });

  it("returns 404 for an org that does not exist, without writing an audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockOrgDetailQuery({ org: null });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(query.mock.calls.some((call) => call[0].includes("private.log_staff_action"))).toBe(false);
  });

  it("returns 403 for a non-staff session without ever querying the org", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(403);
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for an unauthenticated request", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid orgId with a validation error, without querying the org", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/not-a-uuid`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(withServiceRole).toHaveBeenCalledOnce();
  });
});

/**
 * Build order step 8 / Slice 3a (console-plan.md §3, §5, decision 6):
 * PATCH /console/orgs/:orgId/plan. requireStaff's own gate (200/403/401/
 * flag-off) is already covered by the /ping tests above — these tests
 * focus on what's new: the upsert response shape, the 404-when-not-found
 * case, validation, and that BOTH audit rows (staff_audit_log via
 * private.log_staff_action, and the org's own audit_log via the new
 * private.log_org_audit) are written with matching detail payloads.
 */
function mockPatchOrgPlanQuery(options: { orgExists: boolean; planTier?: string; workflowLimit?: number | null }) {
  const { orgExists, planTier = "Enterprise", workflowLimit = 100 } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("private.log_org_audit")) return { rows: [], rowCount: 0 };
    if (sql.includes("select id from public.organizations")) {
      return { rows: orgExists ? [{ id: "org-1" }] : [], rowCount: orgExists ? 1 : 0 };
    }
    if (sql.includes("insert into public.org_plan")) {
      return { rows: [{ plan_tier: planTier, workflow_limit: workflowLimit }], rowCount: 1 };
    }
    throw new Error(`mockPatchOrgPlanQuery: unexpected SQL: ${sql}`);
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return query;
}

describe("PATCH /console/orgs/:orgId/plan", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("upserts org_plan and writes both audit rows with matching detail for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockPatchOrgPlanQuery({ orgExists: true, planTier: "Enterprise", workflowLimit: 100 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: 100 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planTier: "Enterprise", workflowLimit: 100 });

    const detail = JSON.stringify({ planTier: "Enterprise", workflowLimit: 100 });
    const staffAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(staffAuditCall?.[1]).toEqual(["staff-1", "org.plan_update", null, orgId, detail]);
    const orgAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_org_audit"));
    expect(orgAuditCall?.[1]).toEqual([orgId, "staff-1", "organization.plan_updated", detail]);
  });

  it("accepts workflowLimit: null (unlimited)", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    mockPatchOrgPlanQuery({ orgExists: true, planTier: "Enterprise", workflowLimit: null });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: null }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planTier: "Enterprise", workflowLimit: null });
  });

  it("returns 404 for an org that does not exist, without writing any audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockPatchOrgPlanQuery({ orgExists: false });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: 100 }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(query.mock.calls.some((call) => call[0].includes("private.log_staff_action"))).toBe(false);
    expect(query.mock.calls.some((call) => call[0].includes("private.log_org_audit"))).toBe(false);
  });

  it("rejects an empty planTier with a validation error, without querying the org", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "", workflowLimit: 100 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("rejects a non-positive workflowLimit with a validation error", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: 0 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 403 for a non-staff session without ever upserting org_plan", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: 100 }),
    });

    expect(res.status).toBe(403);
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for an unauthenticated request", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/plan`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planTier: "Enterprise", workflowLimit: 100 }),
    });

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });
});

/**
 * Build order step 9 / Slice 3b (console-plan.md, decisions 1/2, additions
 * 3-6): POST /console/orgs/:orgId/suspend. requireStaff's own gate (403/401/
 * flag-off) is already covered by the /ping tests above — these tests focus
 * on what's new: the update response shape, the 404-when-not-found case,
 * validation (reason required), and that both audit rows carry the same
 * `{ reason }` detail.
 */
function mockSuspendOrgQuery(options: { orgExists: boolean; suspendedAt?: string; suspendedReason?: string }) {
  const { orgExists, suspendedAt = "2026-02-01T00:00:00.000Z", suspendedReason = "Non-payment" } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("private.log_org_audit")) return { rows: [], rowCount: 0 };
    if (sql.includes("set suspended_at = now()")) {
      return {
        rows: orgExists ? [{ suspended_at: suspendedAt, suspended_reason: suspendedReason }] : [],
        rowCount: orgExists ? 1 : 0,
      };
    }
    throw new Error(`mockSuspendOrgQuery: unexpected SQL: ${sql}`);
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return query;
}

describe("POST /console/orgs/:orgId/suspend", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("suspends the org and writes both audit rows with matching { reason } detail for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockSuspendOrgQuery({
      orgExists: true,
      suspendedAt: "2026-02-01T00:00:00.000Z",
      suspendedReason: "Non-payment",
    });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Non-payment" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "Suspended",
      suspendedAt: "2026-02-01T00:00:00.000Z",
      suspendedReason: "Non-payment",
    });

    const detail = JSON.stringify({ reason: "Non-payment" });
    const staffAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(staffAuditCall?.[1]).toEqual(["staff-1", "org.suspend", null, orgId, detail]);
    const orgAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_org_audit"));
    expect(orgAuditCall?.[1]).toEqual([orgId, "staff-1", "organization.suspended", detail]);
  });

  it("returns 404 for an org that does not exist, without writing any audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockSuspendOrgQuery({ orgExists: false });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Non-payment" }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(query.mock.calls.some((call) => call[0].includes("private.log_staff_action"))).toBe(false);
    expect(query.mock.calls.some((call) => call[0].includes("private.log_org_audit"))).toBe(false);
  });

  it("rejects an empty reason with a validation error, without updating the org", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("rejects a missing reason with a validation error", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 403 for a non-staff session without ever updating the org", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Non-payment" }),
    });

    expect(res.status).toBe(403);
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for an unauthenticated request", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Non-payment" }),
    });

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });
});

/**
 * Addition 6: POST /console/orgs/:orgId/unsuspend. `note` is optional and
 * never stored on `organizations` itself — only in the two audit rows'
 * detail — so these tests cover both the with-note and omitted-note cases.
 */
function mockUnsuspendOrgQuery(options: { orgExists: boolean }) {
  const { orgExists } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("platform_staff")) return { rowCount: 1 };
    if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
    if (sql.includes("private.log_org_audit")) return { rows: [], rowCount: 0 };
    if (sql.includes("set suspended_at = null")) {
      return { rows: orgExists ? [{ id: "org-1" }] : [], rowCount: orgExists ? 1 : 0 };
    }
    throw new Error(`mockUnsuspendOrgQuery: unexpected SQL: ${sql}`);
  });
  withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return query;
}

describe("POST /console/orgs/:orgId/unsuspend", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("unsuspends the org and writes both audit rows with the given note for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockUnsuspendOrgQuery({ orgExists: true });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/unsuspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ note: "Payment received" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "Active" });

    const detail = JSON.stringify({ note: "Payment received" });
    const staffAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(staffAuditCall?.[1]).toEqual(["staff-1", "org.unsuspend", null, orgId, detail]);
    const orgAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_org_audit"));
    expect(orgAuditCall?.[1]).toEqual([orgId, "staff-1", "organization.unsuspended", detail]);
  });

  it("accepts an omitted note, writing { note: null } to both audit rows", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockUnsuspendOrgQuery({ orgExists: true });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/unsuspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "Active" });

    const detail = JSON.stringify({ note: null });
    const staffAuditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(staffAuditCall?.[1]).toEqual(["staff-1", "org.unsuspend", null, orgId, detail]);
  });

  it("returns 404 for an org that does not exist, without writing any audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockUnsuspendOrgQuery({ orgExists: false });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000/unsuspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(query.mock.calls.some((call) => call[0].includes("private.log_staff_action"))).toBe(false);
    expect(query.mock.calls.some((call) => call[0].includes("private.log_org_audit"))).toBe(false);
  });

  it("rejects a note longer than 500 characters with a validation error", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/unsuspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(501) }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 403 for a non-staff session without ever updating the org", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "user@nia.dev" } });
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/unsuspend`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect(withServiceRole).toHaveBeenCalledOnce();
  });

  it("returns 401 for an unauthenticated request", async () => {
    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/unsuspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    expect(withServiceRole).not.toHaveBeenCalled();
  });
});

describe("GET /console/orgs/:orgId/runs", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("returns run history with error metadata and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const runRows = [
      {
        id: "run-1",
        workflow_id: "wf-1",
        status: "failed",
        error: { message: "Destination write failed: boom" },
        rows_processed: 42,
        duration_ms: 1500,
        started_at: "2026-02-01T00:00:00.000Z",
        finished_at: "2026-02-01T00:00:02.000Z",
      },
      {
        id: "run-2",
        workflow_id: "wf-1",
        status: "succeeded",
        error: null,
        rows_processed: 100,
        duration_ms: 3000,
        started_at: "2026-01-30T00:00:00.000Z",
        finished_at: "2026-01-30T00:00:03.000Z",
      },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("from public.organizations")) return { rows: [{ id: orgId }], rowCount: 1 };
      if (sql.includes("from public.workflow_runs")) return { rows: runRows, rowCount: runRows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/runs`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runs: [
        {
          id: "run-1",
          workflowId: "wf-1",
          status: "failed",
          error: { code: "RUN_FAILED", message: "Destination write failed: boom" },
          rowsProcessed: 42,
          durationMs: 1500,
          startedAt: "2026-02-01T00:00:00.000Z",
          finishedAt: "2026-02-01T00:00:02.000Z",
        },
        {
          id: "run-2",
          workflowId: "wf-1",
          status: "succeeded",
          error: null,
          rowsProcessed: 100,
          durationMs: 3000,
          startedAt: "2026-01-30T00:00:00.000Z",
          finishedAt: "2026-01-30T00:00:03.000Z",
        },
      ],
    });

    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual(["staff-1", "org.runs_read", null, orgId, JSON.stringify({ count: 2 })]);
  });

  it("returns 404 for an org that does not exist, without writing an audit row", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("from public.organizations")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/00000000-0000-0000-0000-000000000000/runs`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(query.mock.calls.some((call) => call[0].includes("private.log_staff_action"))).toBe(false);
  });

  // Small fix (2026-09-29): a destination-write duplicate-key failure's raw
  // error text embeds the customer's own row value in Postgres's DETAIL
  // fragment — the console (staff) response must never leak it.
  it("strips the customer value from a duplicate-key error's DETAIL fragment", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const runRows = [
      {
        id: "run-1",
        workflow_id: "wf-1",
        status: "failed",
        error: {
          message:
            'duplicate key value violates unique constraint "customers_email_key"\nDETAIL:  Key (email)=(user@example.com) already exists.',
        },
        rows_processed: 7,
        duration_ms: 900,
        started_at: "2026-02-01T00:00:00.000Z",
        finished_at: "2026-02-01T00:00:01.000Z",
      },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("from public.organizations")) return { rows: [{ id: orgId }], rowCount: 1 };
      if (sql.includes("from public.workflow_runs")) return { rows: runRows, rowCount: runRows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/runs`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs[0].error).toEqual({
      code: "DUPLICATE_KEY",
      message: 'duplicate key value violates unique constraint "customers_email_key"',
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("user@example.com");
    expect(raw).not.toContain("Key (");
    expect(raw).not.toContain("DETAIL");
  });
});

describe("GET /console/orgs/:orgId/connectors", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("returns connector health metadata and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const connectionRows = [
      {
        id: "conn-1",
        connector_id: "mysql",
        display_name: "Sales DB",
        last_test_status: "ok",
        last_test_latency_ms: 42,
        last_test_at: "2026-02-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "conn-2",
        connector_id: "mongodb",
        display_name: "Events store",
        last_test_status: null,
        last_test_latency_ms: null,
        last_test_at: null,
        created_at: "2026-01-15T00:00:00.000Z",
      },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("from public.organizations")) return { rows: [{ id: orgId }], rowCount: 1 };
      if (sql.includes("from public.connections")) return { rows: connectionRows, rowCount: connectionRows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/connectors`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectors: [
        {
          id: "conn-1",
          connectorId: "mysql",
          displayName: "Sales DB",
          lastTestStatus: "ok",
          lastTestLatencyMs: 42,
          lastTestAt: "2026-02-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "conn-2",
          connectorId: "mongodb",
          displayName: "Events store",
          lastTestStatus: null,
          lastTestLatencyMs: null,
          lastTestAt: null,
          createdAt: "2026-01-15T00:00:00.000Z",
        },
      ],
    });

    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual(["staff-1", "org.connectors_read", null, orgId, JSON.stringify({ count: 2 })]);
  });

  // Proves both that the route's own SQL never selects the secret-bearing
  // columns, and that a response can never carry them even if a row somehow
  // had them attached (e.g. a future column added to the mock/DB row) —
  // this route's explicit SELECT/response-mapping should drop anything not
  // named in its own allowlist.
  it("never returns vault_secret_ref or config, even if the underlying row carries them", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const connectionRows = [
      {
        id: "conn-1",
        connector_id: "mysql",
        display_name: "Sales DB",
        last_test_status: "ok",
        last_test_latency_ms: 42,
        last_test_at: "2026-02-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        // Not selected by the route's own SQL in real life — included here
        // to prove the response mapping itself is an allowlist, not just
        // reliant on the SELECT list never changing.
        vault_secret_ref: "vault://secret/conn-1",
        config: { host: "prod-db.internal", port: 3306, user: "admin" },
      },
    ];
    let connectorsSql = "";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("from public.organizations")) return { rows: [{ id: orgId }], rowCount: 1 };
      if (sql.includes("from public.connections")) {
        connectorsSql = sql;
        return { rows: connectionRows, rowCount: connectionRows.length };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/orgs/${orgId}/connectors`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.connectors[0]).sort()).toEqual(
      ["id", "connectorId", "displayName", "lastTestStatus", "lastTestLatencyMs", "lastTestAt", "createdAt"].sort(),
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("vault_secret_ref");
    expect(raw).not.toContain("vault://");
    expect(raw).not.toContain("prod-db.internal");
    expect(raw).not.toContain("admin");
    expect(connectorsSql).not.toMatch(/vault_secret_ref|\bconfig\b|select \*/i);
  });
});

describe("GET /console/users", () => {
  it("returns the mapped user list, total/hasMore, and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const userRows = [
      {
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        created_at: "2026-01-01T00:00:00.000Z",
        org_count: "2",
      },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("count(*) as count")) return { rows: [{ count: "1" }], rowCount: 1 };
      if (sql.includes('from public."user"')) return { rows: userRows, rowCount: userRows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/users`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      users: [
        {
          id: "user-1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          orgCount: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual([
      "staff-1",
      "user.list",
      null,
      null,
      JSON.stringify({ search: null, limit: 50, offset: 0, count: 1 }),
    ]);
  });
});

describe("GET /console/users/:userId", () => {
  const userId = "22222222-2222-2222-2222-222222222222";

  it("returns profile, org memberships, and session metadata, and writes one staff_audit_log row for a staff session", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const userRow = {
      id: userId,
      name: "Ada Lovelace",
      email: "ada@example.com",
      email_verified: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const membershipRows = [
      {
        org_id: "org-1",
        org_name: "Acme Inc",
        role: "owner",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes('from public."user"')) return { rows: [userRow], rowCount: 1 };
      if (sql.includes("from public.organization_members")) return { rows: membershipRows, rowCount: 1 };
      if (sql.includes('from public."session"')) {
        return { rows: [{ count: "3", last_sign_in_at: "2026-02-01T00:00:00.000Z" }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/users/${userId}`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: userId,
      name: "Ada Lovelace",
      email: "ada@example.com",
      emailVerified: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      memberships: [{ orgId: "org-1", orgName: "Acme Inc", role: "owner", joinedAt: "2026-01-02T00:00:00.000Z" }],
      sessionCount: 3,
      lastSignInAt: "2026-02-01T00:00:00.000Z",
    });

    const auditCall = query.mock.calls.find((call) => call[0].includes("private.log_staff_action"));
    expect(auditCall?.[1]).toEqual(["staff-1", "user.read", userId, null, JSON.stringify({})]);
  });

  // Proves the route's session query never selects `session.token`, and
  // that a response can never carry a password/token/2FA-secret field even
  // if the underlying rows somehow had one attached (e.g. a future column
  // added to the mock/DB row) — same allowlist-not-just-SELECT-list
  // discipline as the connectors "never returns vault_secret_ref" test.
  it("never returns a password, token, or 2FA-secret field, even if the underlying rows carry them", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);

    const userRow = {
      id: userId,
      name: "Ada Lovelace",
      email: "ada@example.com",
      email_verified: true,
      created_at: "2026-01-01T00:00:00.000Z",
      // Not selected by the route's own SQL in real life — included here to
      // prove the response mapping itself is an allowlist.
      password: "$2b$10$superhashedsecretvalue",
      twoFactorSecret: "JBSWY3DPEHPK3PXP",
    };
    let sessionSql = "";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes('from public."user"')) return { rows: [userRow], rowCount: 1 };
      if (sql.includes("from public.organization_members")) return { rows: [], rowCount: 0 };
      if (sql.includes('from public."session"')) {
        sessionSql = sql;
        return {
          rows: [
            {
              count: "1",
              last_sign_in_at: "2026-02-01T00:00:00.000Z",
              // Also not selected in real life — proving the mapping drops it.
              token: "sess_live_abc123secret",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/users/${userId}`, {
      headers: { authorization: "Bearer good-token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["id", "name", "email", "emailVerified", "createdAt", "memberships", "sessionCount", "lastSignInAt"].sort(),
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("superhashedsecretvalue");
    expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
    expect(raw).not.toContain("sess_live_abc123secret");
    expect(sessionSql).not.toMatch(/\btoken\b|select \*/i);
  });
});

// Slice 3f (console-plan.md build order step 13, decisions 3/4):
// POST /console/users/:userId/revoke-sessions. Lean per the user's own
// instruction — exactly two tests: one proving the DELETE against
// public.session actually runs (the thing that makes the user's *next*
// request unauthenticated, since better-auth's getSession looks the token
// up against this same table), and one proving both audit writes (one
// staff_audit_log row + one audit_log row per org membership).
describe("POST /console/users/:userId/revoke-sessions", () => {
  const userId = "22222222-2222-2222-2222-222222222222";

  function mockRevokeSessionsQuery(options: { userExists: boolean; orgIds?: string[] }) {
    const { userExists, orgIds = [] } = options;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("platform_staff")) return { rowCount: 1 };
      if (sql.includes("private.log_staff_action")) return { rows: [], rowCount: 0 };
      if (sql.includes("private.log_org_audit")) return { rows: [], rowCount: 0 };
      if (sql.includes('select id from public."user"')) {
        return { rows: userExists ? [{ id: userId }] : [], rowCount: userExists ? 1 : 0 };
      }
      if (sql.includes('delete from public."session"')) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("from public.organization_members")) {
        return { rows: orgIds.map((org_id) => ({ org_id })), rowCount: orgIds.length };
      }
      throw new Error(`mockRevokeSessionsQuery: unexpected SQL: ${sql}`);
    });
    withServiceRole.mockImplementation(async (_pool: unknown, fn: (db: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    );
    return query;
  }

  it("deletes every row in public.session for the user, making their next request unauthenticated", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockRevokeSessionsQuery({ userExists: true, orgIds: [] });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/users/${userId}/revoke-sessions`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Suspected compromise" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revokedSessionCount: 2 });

    // The DELETE (unscoped by any session id, scoped only to this user) is
    // what makes any of the user's existing session tokens fail
    // better-auth's getSession lookup on their very next request — there is
    // no separate revoke flag/blocklist, so proving this query ran with the
    // right params is the proof of "next request is unauthenticated".
    const deleteCall = query.mock.calls.find((call) => call[0].includes('delete from public."session"'));
    expect(deleteCall?.[1]).toEqual([userId]);
  });

  it("writes one staff_audit_log row and one audit_log row per org the user belongs to", async () => {
    getSession.mockResolvedValue(STAFF_SESSION);
    const query = mockRevokeSessionsQuery({ userExists: true, orgIds: ["org-1", "org-2"] });

    const started = await startServer(buildApp({ mountConsole: true }));
    server = started.server;
    const res = await fetch(`${started.baseUrl}/console/users/${userId}/revoke-sessions`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Suspected compromise" }),
    });

    expect(res.status).toBe(200);

    const detail = JSON.stringify({ reason: "Suspected compromise", revokedCount: 2 });

    const staffAuditCalls = query.mock.calls.filter((call) => call[0].includes("private.log_staff_action"));
    expect(staffAuditCalls).toHaveLength(1);
    expect(staffAuditCalls[0]?.[1]).toEqual(["staff-1", "user.revoke_sessions", userId, null, detail]);

    const orgAuditCalls = query.mock.calls.filter((call) => call[0].includes("private.log_org_audit"));
    expect(orgAuditCalls).toHaveLength(2);
    expect(orgAuditCalls.map((call) => call[1])).toEqual([
      ["org-1", "staff-1", "organization.member_sessions_revoked", detail],
      ["org-2", "staff-1", "organization.member_sessions_revoked", detail],
    ]);
  });
});

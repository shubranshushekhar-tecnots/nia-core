import { describe, expect, it, vi } from "vitest";

// Same mocking posture as app.test.ts: no real socket, no real Postgres.
const mockQuery = vi.fn();
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

async function freshApp() {
  vi.resetModules();
  mockQuery.mockReset();
  const { buildApp } = await import("./app.js");
  return buildApp();
}

const AGENT_ROW = {
  id: "agent-1",
  created_by_user_id: "user-1",
  org_id: "org-1",
  owner_id: null,
  host_name: "test-host",
};

const AUTH_HEADER = { authorization: "Bearer test-agent-key" };

describe("agent-bridge workflows routes (route-level)", () => {
  describe("GET /agent-api/workflows", () => {
    it("returns only this agent's platform-published workflows, with derived status and last run", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            setup_id: "setup-1",
            workflow_id: "wf-mine",
            name: "ETL kill-resume smoke",
            wanted_version: 2,
            applied_version: 2,
            rejection_reason: null,
            platform_job_state: { state: "ok" },
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ agent_setup_id: "setup-1", status: "ok", finished_at: "2026-01-01T00:00:00.000Z", rows_sent: 10, error_class: null }],
      });

      const response = await app.inject({ method: "GET", url: "/agent-api/workflows", headers: AUTH_HEADER });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        workflows: [
          {
            workflowId: "wf-mine",
            setupId: "setup-1",
            name: "ETL kill-resume smoke",
            status: "ok",
            errorClass: null,
            rejectionReason: null,
            nextRunAt: null,
            lastRun: { status: "ok", finishedAt: "2026-01-01T00:00:00.000Z", rowsSent: 10, errorClass: null },
          },
        ],
      });

      // Scoped to this agent's own id, never a client-supplied one.
      const [listSql, listParams] = mockQuery.mock.calls[1]!;
      expect(listSql).toContain("agent_setups");
      expect(listParams).toEqual(["agent-1"]);
    });

    it("converts lastRun.rowsSent to a number even when pg returns it as a bigint string", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            setup_id: "setup-1",
            workflow_id: "wf-mine",
            name: "ETL kill-resume smoke",
            wanted_version: 2,
            applied_version: 2,
            rejection_reason: null,
            platform_job_state: { state: "ok" },
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            agent_setup_id: "setup-1",
            status: "ok",
            finished_at: "2026-01-01T00:00:00.000Z",
            rows_sent: "9007199254740993", // bigint column — pg driver returns this as a string
            error_class: null,
          },
        ],
      });

      const response = await app.inject({ method: "GET", url: "/agent-api/workflows", headers: AUTH_HEADER });

      expect(response.statusCode).toBe(200);
      const { lastRun } = response.json().workflows[0];
      expect(lastRun.rowsSent).toBe(9007199254740993);
      expect(typeof lastRun.rowsSent).toBe("number");
    });

    it("returns an empty list (no second query) when this agent has no published workflows", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no agent_setups rows

      const response = await app.inject({ method: "GET", url: "/agent-api/workflows", headers: AUTH_HEADER });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workflows: [] });
      expect(mockQuery.mock.calls.length).toBe(2);
    });
  });

  describe("GET /agent-api/workflows/:workflowId/runs", () => {
    it("404s a workflow that isn't this agent's own (never 403 — same posture as the setup routes)", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check — no matching setup

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-other-agent/runs",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns this agent's own run history, newest first, mapped to camelCase", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "setup-1" }] }); // ownership check — mine
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            run_id: "run-id-1",
            status: "ok",
            rows_sent: 42,
            rows_deleted: 0,
            mode: "incremental",
            duration_ms: 1200,
            error_class: null,
            started_at: "2026-10-09T00:00:00.000Z",
            finished_at: "2026-10-09T00:00:01.200Z",
          },
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-mine/runs",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        runs: [
          {
            id: "run-1",
            runId: "run-id-1",
            status: "ok",
            rowsSent: 42,
            rowsDeleted: 0,
            mode: "incremental",
            durationMs: 1200,
            errorClass: null,
            startedAt: "2026-10-09T00:00:00.000Z",
            finishedAt: "2026-10-09T00:00:01.200Z",
          },
        ],
      });

      // Ownership check is always scoped to this agent's id, not a client-supplied one.
      const [ownershipSql, ownershipParams] = mockQuery.mock.calls[1]!;
      expect(ownershipSql).toContain("agent_setups");
      expect(ownershipParams).toEqual(["wf-mine", "agent-1"]);
    });

    it("converts rows_sent/rows_deleted to numbers even when pg returns them as bigint strings", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "setup-1" }] }); // ownership check — mine
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            run_id: "run-id-1",
            status: "ok",
            rows_sent: "9007199254740993", // bigint column — pg driver returns this as a string
            rows_deleted: "0",
            mode: "incremental",
            duration_ms: 1200,
            error_class: null,
            started_at: "2026-10-09T00:00:00.000Z",
            finished_at: "2026-10-09T00:00:01.200Z",
          },
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-mine/runs",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(200);
      const [run] = response.json().runs;
      expect(run.rowsSent).toBe(9007199254740993);
      expect(run.rowsDeleted).toBe(0);
      expect(typeof run.rowsSent).toBe("number");
      expect(typeof run.rowsDeleted).toBe("number");
    });

    it("clamps an oversized ?limit to the 50-row ceiling", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "setup-1" }] }); // ownership check — mine
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-mine/runs?limit=500",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(200);
      const [, runsParams] = mockQuery.mock.calls[2]!;
      expect(runsParams).toEqual(["setup-1", 50]);
    });
  });

  describe("GET /agent-api/workflows/:workflowId/graph", () => {
    it("404s a workflow that isn't this agent's own", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check — no matching setup

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-other-agent/graph",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(404);
    });

    it("never leaks raw connection config or vault_secret_ref, even when the underlying row carries extra secret fields", async () => {
      const app = await freshApp();
      const connectionId = "11111111-1111-1111-1111-111111111111";
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "setup-1" }] }); // ownership check — mine
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            version: 3,
            graph: {
              nodes: [
                {
                  id: "n1",
                  type: "source",
                  manifestId: "mysql",
                  connectionId,
                  position: { x: 10, y: 20 },
                  config: {
                    entity: { name: "orders", namespace: "sales" },
                    writeMode: "direct",
                    apiKey: "super-secret-api-key",
                    vault_secret_ref: "node-level-secret-should-never-leak",
                  },
                },
              ],
              edges: [],
            },
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: connectionId,
            display_name: "Orders DB",
            config: {
              host: "db.internal.example.com",
              database: "orders",
              vault_secret_ref: "connection-level-secret-should-never-leak",
              password: "super-secret-password",
            },
          },
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-mine/graph",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.nodes).toEqual([
        {
          id: "n1",
          type: "source",
          position: { x: 10, y: 20 },
          manifestName: "MySQL",
          connectionLabel: "Orders DB (db.internal.example.com/orders)",
          region: null,
          entityLabel: "sales.orders",
          writeModeLabel: null, // not a destination node
          resolved: true,
          unknownReason: null,
        },
      ]);

      // Structural guarantee: the raw request body text must never contain any
      // secret value, nor the vault_secret_ref/config keys themselves.
      const raw = response.body;
      expect(raw).not.toContain("vault_secret_ref");
      expect(raw).not.toContain("super-secret-api-key");
      expect(raw).not.toContain("super-secret-password");
      expect(raw).not.toContain("node-level-secret-should-never-leak");
      expect(raw).not.toContain("connection-level-secret-should-never-leak");
    });

    it("marks a node unresolved when its manifest or connection can no longer be found", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "setup-1" }] }); // ownership check — mine
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            version: 1,
            graph: {
              nodes: [{ id: "n1", type: "destination", manifestId: "not-a-real-manifest", position: { x: 0, y: 0 }, config: {} }],
              edges: [],
            },
          },
        ],
      });
      // No connectionId on the node, so no connection-resolution query happens.

      const response = await app.inject({
        method: "GET",
        url: "/agent-api/workflows/wf-mine/graph",
        headers: AUTH_HEADER,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.nodes[0].resolved).toBe(false);
      expect(body.nodes[0].unknownReason).toContain("not-a-real-manifest");
    });
  });

  describe("POST /agent-api/workflows/:workflowId/actions", () => {
    it("404s a workflow that isn't this agent's own", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockRejectedValueOnce(new Error("no matching agent_setups row")); // create_agent_setup_action_task RPC fails

      const response = await app.inject({
        method: "POST",
        url: "/agent-api/workflows/wf-other-agent/actions",
        headers: AUTH_HEADER,
        payload: { kind: "run_now" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("creates a task and writes a distinct audit_log entry with the requesting hostName, for the agent's own workflow", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "task-1" }] }); // create_agent_setup_action_task RPC
      mockQuery.mockResolvedValueOnce({ rows: [] }); // audit_log insert

      const response = await app.inject({
        method: "POST",
        url: "/agent-api/workflows/wf-mine/actions",
        headers: AUTH_HEADER,
        payload: { kind: "run_now" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });

      const [auditSql, auditParams] = mockQuery.mock.calls[2]!;
      expect(auditSql).toContain("agent_setup.action_requested_by_agent");
      expect(auditParams[2]).toBe("user-1"); // actor = agent.createdByUserId
      const detail = JSON.parse(auditParams[3]);
      expect(detail).toEqual({ workflowId: "wf-mine", kind: "run_now", fullReload: undefined, hostName: "test-host" });
    });

    it("rejects a request body that tries to send allowMassDelete at all — the agent app must never be able to request the override", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey

      const response = await app.inject({
        method: "POST",
        url: "/agent-api/workflows/wf-mine/actions",
        headers: AUTH_HEADER,
        payload: { kind: "resume", allowMassDelete: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        kind: "badRequest",
        message: "Mass-delete approval is only possible on the website.",
      });
      // Never reaches the guard check, the RPC, or an audit insert.
      expect(mockQuery.mock.calls.length).toBe(1);
    });

    it("blocks a resume while paused by the mass-delete guard, without ever reaching the task-creation RPC", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({
        rows: [{ platform_job_state: { state: "paused", errorClass: "massDelete" } }],
      }); // resume guard check

      const response = await app.inject({
        method: "POST",
        url: "/agent-api/workflows/wf-mine/actions",
        headers: AUTH_HEADER,
        payload: { kind: "resume" },
      });

      expect(response.statusCode).toBe(403);
      // Only the two guard-check queries ran — never the task-creation RPC or an audit insert.
      expect(mockQuery.mock.calls.length).toBe(2);
    });

    it("allows a resume when paused for any other reason", async () => {
      const app = await freshApp();
      mockQuery.mockResolvedValueOnce({ rows: [AGENT_ROW] }); // resolveAgentFromKey
      mockQuery.mockResolvedValueOnce({ rows: [{ platform_job_state: { state: "paused", errorClass: "connectionError" } }] }); // resume guard check — not massDelete
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "task-2" }] }); // create_agent_setup_action_task RPC
      mockQuery.mockResolvedValueOnce({ rows: [] }); // audit_log insert

      const response = await app.inject({
        method: "POST",
        url: "/agent-api/workflows/wf-mine/actions",
        headers: AUTH_HEADER,
        payload: { kind: "resume" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });
  });
});

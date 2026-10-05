import { describe, expect, it, vi } from "vitest";

// Mocks @nia/db entirely — no real socket, no real Postgres. Same shape as
// services/connector-mysql/src/pool-manager.test.ts's @nia/db mock.
const mockQuery = vi.fn();
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

async function freshApp() {
  vi.resetModules();
  mockQuery.mockReset();
  const { buildApp } = await import("./app.js");
  return buildApp;
}

describe("agent-bridge /check-in (route-level)", () => {
  it("a check-in with a valid key updates last check-in and returns an empty task list after the hold", async () => {
    const buildApp = await freshApp();

    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1", status: "active" }] });

    // Injected transport stands in for the real 25s hold (LongPollTransport)
    // — buildApp's factory signature (src/app.ts) accepts any AgentTransport.
    const waitForTasks = vi.fn(async () => []);
    const app = buildApp({ waitForTasks });

    const response = await app.inject({
      method: "POST",
      url: "/agent-api/check-in",
      headers: { authorization: "Bearer test-agent-key" },
      payload: { agentVersion: "1.0.0", hostName: "test-host" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tasks: [], acknowledgedRunIds: [] });
    expect(waitForTasks).toHaveBeenCalledWith("agent-1", 25_000);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("update public.platform_agents");
    expect(params[1]).toBe("1.0.0");
    expect(params[2]).toBe("test-host");
  });

  it("a check-in with noHold:true skips the hold entirely", async () => {
    const buildApp = await freshApp();

    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1", status: "active" }] });

    const waitForTasks = vi.fn(async () => []);
    const app = buildApp({ waitForTasks });

    const response = await app.inject({
      method: "POST",
      url: "/agent-api/check-in",
      headers: { authorization: "Bearer test-agent-key" },
      payload: { agentVersion: "1.0.0", hostName: "test-host", noHold: true },
    });

    expect(response.statusCode).toBe(200);
    expect(waitForTasks).toHaveBeenCalledWith("agent-1", 0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// docs/plans/agent-canvas-integration.md Slice L3 — exactly 3 tests
// (Allowed / Refused / Guard), per spec. Mirrors members/actions.test.ts's
// mocking convention, adapted for this feature's HTTP-via-apiFetchServer
// calls instead of withActingUser's direct DB access.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireUser: () => requireUser() }));

class MockApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const apiFetchServer = vi.fn();
vi.mock("@/lib/api/server", () => ({
  apiFetchServer: (...args: unknown[]) => apiFetchServer(...args),
  ApiError: MockApiError,
}));

const { pairAgentAction, revokeAgentAction } = await import("./actions");
const { can, canManageAgent } = await import("@nia/schemas");
const { mapAgent, mapAgents } = await import("./mapAgent");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  apiFetchServer.mockReset();
  requireUser.mockReset();
});

describe("Allowed: a member adds an agent and the pairing command is shown once", () => {
  it("pairAgentAction returns success with a one-time code for a member", async () => {
    requireUser.mockResolvedValue({ userId: "user-1", role: "member", org: { id: "org-1" } });
    apiFetchServer.mockResolvedValue({
      pairingCodeId: "code-id-1",
      code: "abc123secret",
      expiresAt: "2026-10-06T00:00:00.000Z",
    });

    const result = await pairAgentAction(null, formData({ name: "laptop-etl" }));

    expect(result?.success).toBe(true);
    expect(result?.code).toBe("abc123secret");
    expect(result?.expiresAt).toBe("2026-10-06T00:00:00.000Z");
    expect(apiFetchServer).toHaveBeenCalledTimes(1);
    expect(apiFetchServer).toHaveBeenCalledWith("/agents/pair", { method: "POST" });
  });
});

describe("Refused: a viewer sees no Add/Revoke control, and the server rejects the same actions from a viewer", () => {
  it("the capability matrix hides Add/Revoke controls from a viewer", () => {
    expect(can("viewer", "agents.view")).toBe(true);
    expect(can("viewer", "agents.pair")).toBe(false);
    expect(canManageAgent("viewer", "user-1", "user-1")).toBe(false);
  });

  it("pairAgentAction rejects a viewer before ever calling the API", async () => {
    requireUser.mockResolvedValue({ userId: "user-2", role: "viewer", org: { id: "org-1" } });

    const result = await pairAgentAction(null, formData({ name: "laptop-etl" }));

    expect(result?.error).toBeTruthy();
    expect(result?.success).toBeUndefined();
    expect(apiFetchServer).not.toHaveBeenCalled();
  });

  it("revokeAgentAction surfaces the server's rejection for a non-owning actor", async () => {
    apiFetchServer.mockRejectedValue(
      new MockApiError(403, "INSUFFICIENT_ROLE", "Only an admin, owner, or the member who paired this agent may revoke it."),
    );

    const result = await revokeAgentAction(null, formData({ agentId: "agent-1" }));

    expect(result?.error).toBe("Only an admin, owner, or the member who paired this agent may revoke it.");
  });
});

describe("Guard: after the dialog closes, the token is not present anywhere on the page or in a later response", () => {
  it("mapAgent strips any pairing-secret-like field from a raw /agents row", () => {
    const leaked = {
      id: "agent-1",
      displayName: "laptop-etl",
      status: "active",
      agentVersion: "1.0.0",
      hostName: "mac.local",
      lastCheckInAt: "2026-10-05T00:00:00.000Z",
      createdByUserId: "user-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      online: true,
      // Hypothetical leak: if a future /agents list response ever included
      // the one-time pairing secret on a row, mapAgent must still drop it.
      code: "super-secret-token",
      agentKey: "super-secret-key",
    };

    const mapped = mapAgent(leaked);

    expect(mapped).not.toHaveProperty("code");
    expect(mapped).not.toHaveProperty("agentKey");
    expect(JSON.stringify(mapped)).not.toContain("super-secret");

    const mappedList = mapAgents([leaked]);
    expect(JSON.stringify(mappedList)).not.toContain("super-secret");
  });
});

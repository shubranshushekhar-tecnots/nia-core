import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GraphDoc } from "@nia/schemas";

/**
 * Task 3, item 4 — covers the plan's "ProposalSchema parsing (valid,
 * prose-wrapped via the salvage path, invalid)" bullet at the level it
 * actually matters: through proposeMapping()'s real completeJson/extractJson
 * call, not just ProposalSchema.safeParse in isolation (extractJson itself
 * already has its own generic salvage-path tests in ../llm/parseHelpers.test.ts).
 * Also covers the hallucination filter (entries referencing field names not
 * present in either introspected schema are dropped).
 */

const resolveGraphMock = vi.fn();
vi.mock("../checks/runWorkflowChecks.js", () => ({
  resolveGraph: (...args: unknown[]) => resolveGraphMock(...args),
}));

const resolveConnectionMock = vi.fn();
vi.mock("../resolveConnection.js", () => ({
  resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args),
}));

const getSchemaMock = vi.fn();
vi.mock("../introspection.js", () => ({
  getSchema: (...args: unknown[]) => getSchemaMock(...args),
}));

const completeMock = vi.fn();
vi.mock("../llm/gatewayClient.js", () => ({
  complete: (...args: unknown[]) => completeMock(...args),
}));

const { proposeMapping } = await import("./proposeMapping.js");

const SCOPE = { orgId: "org-1" };
const SOURCE_CONN = "11111111-1111-1111-1111-111111111111";
const DEST_CONN = "22222222-2222-2222-2222-222222222222";

function graph(): GraphDoc {
  return {
    nodes: [
      { id: "src", type: "source", manifestId: "mysql", connectionId: SOURCE_CONN, position: { x: 0, y: 0 }, config: {} },
      { id: "dest", type: "destination", manifestId: "supabase", connectionId: DEST_CONN, position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [{ id: "e1", source: "src", target: "dest" }],
  };
}

function schema(fields: string[]) {
  return { ok: true as const, value: { entities: [{ namespace: "public", name: "t", fields: fields.map((name) => ({ name, type: "text" })) }] } };
}

beforeEach(() => {
  resolveGraphMock.mockReset();
  resolveConnectionMock.mockReset();
  getSchemaMock.mockReset();
  completeMock.mockReset();

  resolveGraphMock.mockResolvedValue(graph());
  resolveConnectionMock.mockImplementation(async (connectionId: string) => ({
    ok: true,
    value: { id: connectionId, manifest: {}, credential: {}, config: {} },
  }));
  getSchemaMock.mockImplementation(async (connection: { id: string }) =>
    connection.id === SOURCE_CONN ? schema(["first_name", "last_name", "email"]) : schema(["full_name", "email_address"]),
  );
});

describe("proposeMapping", () => {
  it("returns a valid proposal parsed from clean JSON", async () => {
    completeMock.mockResolvedValueOnce('{"entries":[{"from":"email","to":"email_address"}]}');

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result).toEqual({ ok: true, value: { entries: [{ from: "email", to: "email_address" }] } });
  });

  it("salvages a proposal wrapped in prose via the extractJson fallback path", async () => {
    completeMock.mockResolvedValueOnce(
      'Sure, here is my proposed mapping:\n{"entries":[{"from":"email","to":"email_address"}]}\nLet me know if you want changes.',
    );

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result).toEqual({ ok: true, value: { entries: [{ from: "email", to: "email_address" }] } });
  });

  it("drops hallucinated entries referencing fields absent from both introspected schemas", async () => {
    completeMock.mockResolvedValueOnce(
      '{"entries":[{"from":"email","to":"email_address"},{"from":"made_up_field","to":"email_address"},{"from":"email","to":"made_up_dest"}]}',
    );

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result).toEqual({ ok: true, value: { entries: [{ from: "email", to: "email_address" }] } });
  });

  it("fails with llm-failed when the model output never parses as JSON, even after the retry", async () => {
    completeMock.mockResolvedValueOnce("I cannot help with that.");
    completeMock.mockResolvedValueOnce("Still cannot help.");

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("llm-failed");
  });

  it("fails with llm-failed when the parsed JSON doesn't match ProposalSchema's shape", async () => {
    completeMock.mockResolvedValueOnce('{"mapping":"not the right shape"}');

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("llm-failed");
  });

  it("fails with workflow-not-found when resolveGraph returns null", async () => {
    resolveGraphMock.mockResolvedValueOnce(null);

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result).toEqual({ ok: false, error: { kind: "workflow-not-found", message: expect.stringContaining("not found") } });
  });

  it("fails with homogeneous-path when source and destination share a manifest", async () => {
    resolveGraphMock.mockResolvedValueOnce({
      nodes: [
        { id: "src", type: "source", manifestId: "mysql", connectionId: SOURCE_CONN, position: { x: 0, y: 0 }, config: {} },
        { id: "dest", type: "destination", manifestId: "mysql", connectionId: DEST_CONN, position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "src", target: "dest" }],
    });

    const result = await proposeMapping("wf-1", "dest", SCOPE);

    expect(result).toEqual({ ok: false, error: { kind: "homogeneous-path", message: expect.stringContaining("no field mapping is needed") } });
  });
});

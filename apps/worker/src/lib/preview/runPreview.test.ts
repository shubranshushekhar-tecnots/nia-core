import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GraphDoc, PreviewJob } from "@nia/schemas";

/**
 * Block 1 (Phase 5 Session 5) — covers runPreview.ts's orchestration at the
 * level that actually matters: through the real resolveSourceEntity,
 * checkConfig/checkMappings, and compilePushdown calls (not re-testing those
 * in isolation, they already have their own unit tests), mocking only the
 * I/O boundary (resolveGraph/resolveConnection/getSchema/dispatch) the same
 * way proposeMapping.test.ts does.
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

const dispatchMock = vi.fn();
vi.mock("../dispatch.js", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
}));

const { runPreview, findSourcePath } = await import("./runPreview.js");

const SCOPE = { orgId: "org-1" };
const SOURCE_CONN = "11111111-1111-1111-1111-111111111111";
const DEST_CONN = "22222222-2222-2222-2222-222222222222";

function baseJob(overrides: Partial<PreviewJob> = {}): PreviewJob {
  return { kind: "preview_run", scope: SCOPE, workflowId: "wf-1", destNodeId: "dest", triggeredByUserId: "user-1", ...overrides };
}

function approvedMapping(entries: { from: string; to: string }[] = [{ from: "email", to: "email_address" }]) {
  return { operation: "read" as const, mapping: { version: 1, entries, approvedAt: "2026-01-01T00:00:00.000Z" } };
}

function graph(opts: { mapping?: unknown; transforms?: string[] } = {}): GraphDoc {
  const mapping = opts.mapping === undefined ? approvedMapping() : opts.mapping;
  const transformNodes = (opts.transforms ?? []).map((id) => ({
    id,
    type: "transform" as const,
    position: { x: 0, y: 0 },
    config: {},
  }));
  const chain = ["src", ...(opts.transforms ?? []), "dest"];
  const edges = chain.slice(0, -1).map((source, i) => ({ id: `e${i}`, source, target: chain[i + 1]! }));
  return {
    nodes: [
      { id: "src", type: "source", manifestId: "mysql", connectionId: SOURCE_CONN, position: { x: 0, y: 0 }, config: {} },
      ...transformNodes,
      { id: "dest", type: "destination", manifestId: "supabase", connectionId: DEST_CONN, position: { x: 0, y: 0 }, config: mapping },
    ],
    edges,
  };
}

function schema(fields: string[], entityName = "users") {
  return { ok: true as const, value: { entities: [{ namespace: "public", name: entityName, fields: fields.map((name) => ({ name, type: "string" })) }] } };
}

function tabularResult() {
  return {
    ok: true as const,
    value: {
      columns: [{ name: "email_address", type: "string" as const }],
      rows: [["a@example.com"]],
      meta: { executedQuery: "SELECT 1", connectionId: DEST_CONN, durationMs: 1, rowCount: 1, truncated: false },
    },
  };
}

beforeEach(() => {
  resolveGraphMock.mockReset();
  resolveConnectionMock.mockReset();
  getSchemaMock.mockReset();
  dispatchMock.mockReset();

  resolveGraphMock.mockResolvedValue(graph());
  resolveConnectionMock.mockImplementation(async (connectionId: string) => ({
    ok: true,
    value: { id: connectionId, manifest: {}, credential: {}, config: {} },
  }));
  getSchemaMock.mockResolvedValue(schema(["email", "id"]));
  dispatchMock.mockResolvedValue(tabularResult());
});

describe("findSourcePath", () => {
  it("walks backward through transform nodes to find the nearest source and reconstructs the forward chain", () => {
    const path = findSourcePath("dest", graph({ transforms: ["t1", "t2"] }));
    expect(path?.source.id).toBe("src");
    expect(path?.transforms.map((n) => n.id)).toEqual(["t1", "t2"]);
  });

  it("returns undefined when no upstream source node is reachable", () => {
    const g: GraphDoc = { nodes: [{ id: "dest", type: "destination", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    expect(findSourcePath("dest", g)).toBeUndefined();
  });
});

describe("runPreview", () => {
  it("runs a trivial (no-transform) preview end-to-end, dispatching a read-shaped SELECT capped at 50 rows", async () => {
    const result = await runPreview(baseJob());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.residualCount).toBe(0);
    expect(result.value.truncated).toBe(false);
    expect(result.value.columns).toEqual([{ name: "email_address", type: "string" }]);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [connId, query, , , opts] = dispatchMock.mock.calls[0]!;
    expect(connId).toBe(SOURCE_CONN);
    expect(query.kind).toBe("sql");
    expect(query.sql).toMatch(/^SELECT .* FROM `public`\.`users`$/);
    expect(query.sql).toContain('AS `email_address`');
    expect(opts).toEqual({ rowCap: 50 });
  });

  it("fails with mapping-not-approved when approvedAt is null", async () => {
    resolveGraphMock.mockResolvedValueOnce(graph({ mapping: { operation: "read", mapping: { version: 1, entries: [{ from: "email", to: "email_address" }], approvedAt: null } } }));

    const result = await runPreview(baseJob());

    expect(result).toEqual({ ok: false, error: { kind: "mapping-not-approved", message: expect.any(String) } });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("fails with mapping-not-approved when entries is empty", async () => {
    resolveGraphMock.mockResolvedValueOnce(graph({ mapping: { operation: "read", mapping: { version: 1, entries: [], approvedAt: "2026-01-01T00:00:00.000Z" } } }));

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("mapping-not-approved");
  });

  it("fails with no-upstream-source when the destination has no reachable source node", async () => {
    resolveGraphMock.mockResolvedValueOnce({
      nodes: [{ id: "dest", type: "destination", manifestId: "supabase", connectionId: DEST_CONN, position: { x: 0, y: 0 }, config: approvedMapping() }],
      edges: [],
    });

    const result = await runPreview(baseJob());

    expect(result).toEqual({ ok: false, error: { kind: "no-upstream-source", message: expect.any(String) } });
  });

  it("fails with checks-failing when a mapped source field no longer exists upstream (reuses checkMappings, no new validation)", async () => {
    getSchemaMock.mockResolvedValueOnce(schema(["id"])); // "email" no longer present

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checks-failing");
      expect(result.error.message).toContain("email");
    }
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("fails with entity-unresolved when mapping fields match zero entities", async () => {
    // checkMappings only needs each field name to exist *somewhere* in the
    // flattened union (uniqueFieldNames), so split "email" and "phone"
    // across two entities: checkMappings passes (both names are known) but
    // no single entity is a superset of both, so resolveSourceEntity must
    // fail closed with "no-match" rather than guess.
    getSchemaMock.mockResolvedValueOnce({
      ok: true,
      value: {
        entities: [
          { namespace: "public", name: "users", fields: [{ name: "email", type: "string" }] },
          { namespace: "public", name: "contacts", fields: [{ name: "phone", type: "string" }] },
        ],
      },
    });
    resolveGraphMock.mockResolvedValueOnce(
      graph({ mapping: approvedMapping([{ from: "email", to: "email_address" }, { from: "phone", to: "phone_number" }]) }),
    );

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("entity-unresolved");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("fails with entity-unresolved when mapping fields match more than one entity (never guesses)", async () => {
    getSchemaMock.mockResolvedValueOnce({
      ok: true,
      value: {
        entities: [
          { namespace: "public", name: "users", fields: [{ name: "email", type: "string" }] },
          { namespace: "public", name: "contacts", fields: [{ name: "email", type: "string" }] },
        ],
      },
    });

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("entity-unresolved");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("compiles a single transform node's pushdown normally (WHERE fragment reaches the dispatched query)", async () => {
    const g = graph({ transforms: ["t1"] });
    const transformNode = g.nodes.find((n) => n.id === "t1")!;
    transformNode.config = { steps: [{ kind: "filter", conditions: [{ field: "id", operator: "eq", value: 1 }] }] };
    resolveGraphMock.mockResolvedValueOnce(g);

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.residualCount).toBe(0);
    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.sql).toContain("WHERE");
  });

  it("degrades to fully residual (no chaining attempted) when 2+ transform nodes sit on the path", async () => {
    const g = graph({ transforms: ["t1", "t2"] });
    g.nodes.find((n) => n.id === "t1")!.config = { steps: [{ kind: "filter", conditions: [{ field: "id", operator: "eq", value: 1 }] }] };
    g.nodes.find((n) => n.id === "t2")!.config = { steps: [{ kind: "filter", conditions: [{ field: "id", operator: "eq", value: 2 }] }, { kind: "drop_fields", fields: ["id"] }] };
    resolveGraphMock.mockResolvedValueOnce(g);

    const result = await runPreview(baseJob());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.residualCount).toBe(3); // 1 step on t1 + 2 steps on t2, no chaining across nodes
    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.sql).not.toContain("WHERE"); // dialectQuery was never compiled across multiple nodes
  });

  it("fails with dispatch-failed when dispatch() reports an error", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { kind: "guardrail-rejected", message: "boom" } });

    const result = await runPreview(baseJob());

    expect(result).toEqual({ ok: false, error: { kind: "dispatch-failed", message: "boom" } });
  });
});

import { describe, expect, it } from "vitest";
import { checkConfig, checkCredentials, checkDag, checkGrants, checkMappings } from "./checks.js";
import type { GraphDoc } from "./graph.js";

const CONN = "11111111-1111-1111-1111-111111111111";

function node(overrides: Partial<GraphDoc["nodes"][number]> & { id: string }): GraphDoc["nodes"][number] {
  return { type: "source", position: { x: 0, y: 0 }, config: {}, ...overrides };
}

describe("checkDag", () => {
  it("fails on an empty graph", () => {
    const results = checkDag({ nodes: [], edges: [] });
    expect(results).toEqual([{ id: "dag", status: "fail", message: "Workflow has no nodes." }]);
  });

  it("fails on a cyclic graph", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "a", type: "transform" }), node({ id: "b", type: "transform" })],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "a" },
      ],
    };
    const results = checkDag(graph);
    expect(results.some((r) => r.status === "fail" && r.message.includes("cycle"))).toBe(true);
  });

  it("fails on an orphan node", () => {
    const graph: GraphDoc = {
      nodes: [
        node({ id: "src", type: "source" }),
        node({ id: "dest", type: "destination" }),
        node({ id: "lonely", type: "transform" }),
      ],
      edges: [{ id: "e1", source: "src", target: "dest" }],
    };
    const results = checkDag(graph);
    expect(results.some((r) => r.status === "fail" && r.nodeId === "lonely" && r.message.includes("isn't connected"))).toBe(true);
  });

  it("fails when an edge references a missing node", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "src", type: "source" })],
      edges: [{ id: "e1", source: "src", target: "ghost" }],
    };
    const results = checkDag(graph);
    expect(results.some((r) => r.status === "fail" && r.message.includes("missing target node"))).toBe(true);
  });

  it("fails when there is no source -> destination path", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "src", type: "source" }), node({ id: "t", type: "transform" })],
      edges: [{ id: "e1", source: "src", target: "t" }],
    };
    const results = checkDag(graph);
    expect(results.some((r) => r.status === "fail" && r.message.includes("No path"))).toBe(true);
  });

  it("passes a clean acyclic source->transform->destination graph", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "src", type: "source" }), node({ id: "t", type: "transform" }), node({ id: "dest", type: "destination" })],
      edges: [
        { id: "e1", source: "src", target: "t" },
        { id: "e2", source: "t", target: "dest" },
      ],
    };
    expect(checkDag(graph)).toEqual([{ id: "dag", status: "pass", message: "The workflow graph is a valid, acyclic, fully-connected DAG." }]);
  });
});

describe("checkConfig", () => {
  it("fails an unrecognized config shape", () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "transform", config: { steps: "not-an-array" } })], edges: [] };
    const results = checkConfig(graph);
    expect(results).toEqual([{ id: "config", status: "fail", message: expect.stringContaining("doesn't match the expected shape"), nodeId: "n1" }]);
  });

  it("fails a filter step with no field selected (permissive at the schema layer, not at check time)", () => {
    const graph: GraphDoc = {
      nodes: [
        node({
          id: "n1",
          type: "transform",
          config: { steps: [{ kind: "filter", conditions: [{ field: "", operator: "eq", value: "x" }] }] },
        }),
      ],
      edges: [],
    };
    const results = checkConfig(graph);
    expect(results.some((r) => r.status === "fail" && r.message.includes("no field selected"))).toBe(true);
  });

  it("fails a computed-field step with no output name (permissive at the schema layer, not at check time)", () => {
    const graph: GraphDoc = {
      nodes: [
        node({
          id: "n1",
          type: "transform",
          config: { steps: [{ kind: "computed_field", name: "", expression: { kind: "literal", value: 1 } }] },
        }),
      ],
      edges: [],
    };
    const results = checkConfig(graph);
    expect(results.some((r) => r.status === "fail" && r.message.includes("no output name"))).toBe(true);
  });

  it("fails a source/destination node with no connection selected", () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "source" })], edges: [] };
    const results = checkConfig(graph);
    // A source with no connection also has no entity, so both the fail
    // (blocking) and the Block-0 entity nudge (non-blocking) fire — assert
    // on the fail specifically rather than the full result set.
    expect(results).toContainEqual({ id: "config", status: "fail", message: expect.stringContaining("no connection selected"), nodeId: "n1" });
  });

  it("warns (does not fail) a source node with a connection but no persisted entity", () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "source", connectionId: CONN })], edges: [] };
    const results = checkConfig(graph);
    expect(results).toEqual([
      { id: "config", status: "warn", message: expect.stringContaining("no table selected"), nodeId: "n1" },
    ]);
  });

  it("doesn't warn a source node once a persisted entity is set", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "n1", type: "source", connectionId: CONN, config: { entity: { namespace: "public", name: "users" } } })],
      edges: [],
    };
    expect(checkConfig(graph)).toEqual([{ id: "config", status: "pass", message: "Every node's config is valid and complete." }]);
  });

  it("fails a destination mapping entry with an unset field (permissive at the schema layer, not at check time)", () => {
    const graph: GraphDoc = {
      nodes: [
        node({
          id: "n1",
          type: "destination",
          connectionId: CONN,
          config: { operation: "read", mapping: { version: 1, entries: [{ from: "id", to: "" }], approvedAt: null } },
        }),
      ],
      edges: [],
    };
    const results = checkConfig(graph);
    expect(results.some((r) => r.status === "fail" && r.nodeId === "n1" && r.message.includes("mapping entry"))).toBe(true);
  });

  it("passes a fully valid graph", () => {
    const graph: GraphDoc = {
      nodes: [
        node({ id: "n1", type: "source", connectionId: CONN, config: { entity: { namespace: "public", name: "users" } } }),
        node({ id: "n2", type: "transform", config: { steps: [] } }),
      ],
      edges: [],
    };
    expect(checkConfig(graph)).toEqual([{ id: "config", status: "pass", message: "Every node's config is valid and complete." }]);
  });
});

describe("checkGrants", () => {
  it("passes when no operation is configured", () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "source" })], edges: [] };
    expect(checkGrants(graph)).toEqual([{ id: "grants", status: "pass", message: "No write operations configured anywhere in this workflow." }]);
  });

  it("passes for the read operation", () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "source", config: { operation: "read" } })], edges: [] };
    expect(checkGrants(graph)[0]!.status).toBe("pass");
  });

  it("fails loudly (tripwire) if a write verb appears in config, even alongside an otherwise-unrecognized shape", () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "n1", type: "destination", config: { operation: "insert", garbage: true } })],
      edges: [],
    };
    const results = checkGrants(graph);
    expect(results).toEqual([{ id: "grants", status: "fail", message: expect.stringContaining('write operation "insert"'), nodeId: "n1" }]);
  });
});

describe("checkCredentials", () => {
  it("passes trivially when no node references a connection", async () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "transform" })], edges: [] };
    const results = await checkCredentials(graph, async () => ({ ok: true }));
    expect(results).toEqual([{ id: "credentials", status: "pass", message: "No connections referenced." }]);
  });

  it("fails when the injected test function reports failure", async () => {
    const graph: GraphDoc = { nodes: [node({ id: "n1", type: "source", connectionId: CONN })], edges: [] };
    const results = await checkCredentials(graph, async () => ({ ok: false, message: "auth error" }));
    expect(results).toEqual([{ id: "credentials", status: "fail", message: expect.stringContaining("auth error"), nodeId: "n1" }]);
  });

  it("dedupes nodes sharing the same connection into a single test call", async () => {
    const graph: GraphDoc = {
      nodes: [node({ id: "n1", type: "source", connectionId: CONN }), node({ id: "n2", type: "destination", connectionId: CONN })],
      edges: [],
    };
    let calls = 0;
    await checkCredentials(graph, async () => {
      calls++;
      return { ok: true };
    });
    expect(calls).toBe(1);
  });
});

describe("checkMappings", () => {
  const source = node({ id: "src", type: "source", manifestId: "mysql" });
  const dest = node({ id: "dest", type: "destination", manifestId: "supabase" });
  const edge = { id: "e1", source: "src", target: "dest" };

  function destWithMapping(mapping?: { entries: { from: string; to: string }[]; approvedAt: string | null }) {
    return { ...dest, config: mapping ? { mapping: { version: 1, ...mapping } } : {} };
  }

  it("passes automatically for a homogeneous (same-manifest) path with no mapping needed", () => {
    const graph: GraphDoc = { nodes: [{ ...source, manifestId: "mysql" }, { ...dest, manifestId: "mysql" }], edges: [edge] };
    expect(checkMappings(graph, () => undefined)).toEqual([
      { id: "mappings", status: "pass", message: "Every heterogeneous source-to-destination path has an approved, drift-free mapping." },
    ]);
  });

  it("fails a heterogeneous path with no approved mapping", () => {
    const graph: GraphDoc = { nodes: [source, destWithMapping()], edges: [edge] };
    const results = checkMappings(graph, () => undefined);
    expect(results).toEqual([{ id: "mappings", status: "fail", message: expect.stringContaining("no approved field mapping"), nodeId: "dest" }]);
  });

  it("fails on drift: a mapped source field no longer exists upstream", () => {
    const graph: GraphDoc = {
      nodes: [source, destWithMapping({ entries: [{ from: "old_col", to: "new_col" }], approvedAt: "2026-01-01T00:00:00Z" })],
      edges: [edge],
    };
    const results = checkMappings(graph, () => ["current_col"]);
    expect(results).toEqual([
      { id: "mappings", status: "fail", message: expect.stringContaining('"old_col" no longer exists upstream'), nodeId: "dest" },
    ]);
  });

  it("passes an approved mapping whose fields still exist", () => {
    const graph: GraphDoc = {
      nodes: [source, destWithMapping({ entries: [{ from: "current_col", to: "new_col" }], approvedAt: "2026-01-01T00:00:00Z" })],
      edges: [edge],
    };
    const results = checkMappings(graph, () => ["current_col"]);
    expect(results[0]!.status).toBe("pass");
  });

  it("skips drift verification (does not fail) when introspection data is unavailable", () => {
    const graph: GraphDoc = {
      nodes: [source, destWithMapping({ entries: [{ from: "old_col", to: "new_col" }], approvedAt: "2026-01-01T00:00:00Z" })],
      edges: [edge],
    };
    const results = checkMappings(graph, () => undefined);
    expect(results[0]!.status).toBe("pass");
  });

  it("fails an edited-but-unapproved mapping (approvedAt cleared) even though entries are present", () => {
    const graph: GraphDoc = {
      nodes: [source, destWithMapping({ entries: [{ from: "current_col", to: "new_col" }], approvedAt: null })],
      edges: [edge],
    };
    const results = checkMappings(graph, () => ["current_col"]);
    expect(results).toEqual([{ id: "mappings", status: "fail", message: expect.stringContaining("no approved field mapping"), nodeId: "dest" }]);
  });
});

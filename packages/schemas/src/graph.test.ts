import { describe, it, expect } from "vitest";
import { GraphDoc } from "./graph.js";

describe("GraphDoc", () => {
  it("round-trips a full graph (3 node kinds, manifest+connection-backed nodes, an edge with handles) through JSON unchanged", () => {
    const fixture = {
      nodes: [
        {
          id: "n1",
          type: "source",
          connectionId: "11111111-1111-4111-8111-111111111111",
          manifestId: "mysql",
          position: { x: 48.5, y: 60 },
          config: { table: "orders" },
        },
        {
          id: "n2",
          type: "transform",
          position: { x: 428, y: 60 },
          config: {},
        },
        {
          id: "n3",
          type: "destination",
          connectionId: "22222222-2222-4222-8222-222222222222",
          manifestId: "supabase",
          position: { x: 808, y: 60 },
          config: {},
        },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3", sourceHandle: "out", targetHandle: "in" },
      ],
    };

    const parsed = GraphDoc.parse(fixture);
    const roundTripped = GraphDoc.parse(JSON.parse(JSON.stringify(parsed)));

    expect(roundTripped).toEqual(parsed);
  });

  it("defaults nodes/edges/config to empty when omitted", () => {
    const doc = GraphDoc.parse({});
    expect(doc).toEqual({ nodes: [], edges: [] });
  });

  it("rejects a node type outside source|transform|destination", () => {
    expect(() =>
      GraphDoc.parse({
        nodes: [{ id: "n1", type: "trigger", position: { x: 0, y: 0 } }],
        edges: [],
      }),
    ).toThrow();
  });

  it("rejects a manifestId with characters outside [a-z0-9-]", () => {
    expect(() =>
      GraphDoc.parse({
        nodes: [{ id: "n1", type: "source", manifestId: "MySQL!", position: { x: 0, y: 0 } }],
        edges: [],
      }),
    ).toThrow();
  });

  it("allows an unknown manifestId string through (registry lookup, not schema validation, decides resolvability)", () => {
    const doc = GraphDoc.parse({
      nodes: [{ id: "n1", type: "source", manifestId: "not-a-real-connector", position: { x: 0, y: 0 } }],
      edges: [],
    });
    expect(doc.nodes[0]!.manifestId).toBe("not-a-real-connector");
  });

  it("threads parkedLegacyTriggers through unchanged when present", () => {
    const fixture = {
      nodes: [],
      edges: [],
      parkedLegacyTriggers: [{ id: "old-trigger-1", kind: "trigger", tool: "webhook" }],
    };
    const parsed = GraphDoc.parse(fixture);
    const roundTripped = GraphDoc.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

import { describe, expect, it } from "vitest";
import { deriveAgentJobSetupFromGraph } from "./agentJobSetupFromGraph.js";
import { conditionsToExpr } from "./nodeConfig.js";
import type { GraphDoc } from "./graph.js";

const SOURCE_CONN = "11111111-1111-1111-1111-111111111111";
const DEST_CONN = "22222222-2222-2222-2222-222222222222";

function node(overrides: Partial<GraphDoc["nodes"][number]> & { id: string }): GraphDoc["nodes"][number] {
  return { type: "source", position: { x: 0, y: 0 }, config: {}, ...overrides };
}

/** A graph with a flat, parameter-using filter and every key column mapped — the "Allowed" case. */
function allowedGraph(): GraphDoc {
  return {
    nodes: [
      node({
        id: "src",
        type: "source",
        manifestId: "sqlserver-agent",
        connectionId: SOURCE_CONN,
        config: {
          entity: { namespace: "dbo", name: "vw_salesdata" },
          columns: [
            { name: "id", type: "int", isKey: true },
            { name: "amount", type: "decimal", isKey: false },
          ],
          params: { minAmount: "100" },
        },
      }),
      node({
        id: "filter",
        type: "transform",
        config: {
          steps: [{ kind: "filter", expr: conditionsToExpr([{ field: "amount", operator: "gte", value: "minAmount" }]) }],
        },
      }),
      node({
        id: "dest",
        type: "destination",
        manifestId: "planometry-table",
        connectionId: DEST_CONN,
        config: {
          mapping: { version: 1, entries: [{ from: "id", to: "id" }, { from: "amount", to: "amount" }], approvedAt: null },
          delivery: { mode: "replace" },
        },
      }),
    ],
    edges: [
      { id: "e1", source: "src", target: "filter" },
      { id: "e2", source: "filter", target: "dest" },
    ],
  };
}

describe("deriveAgentJobSetupFromGraph", () => {
  it("Allowed: a local source, a flat parameter-using filter, every key mapped, and a Planometry destination becomes a valid setup", () => {
    const result = deriveAgentJobSetupFromGraph(allowedGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setup.sourceConnectionId).toBe(SOURCE_CONN);
    expect(result.setup.sourceTable).toBe("dbo.vw_salesdata");
    expect(result.setup.destinationConnectionId).toBe(DEST_CONN);
    expect(result.setup.mode).toBe("replace");
    expect(result.setup.filter).toEqual([{ field: "amount", operator: "gte", value: "minAmount" }]);
    expect(result.setup.mapping).toEqual([{ source: "id", target: "id" }, { source: "amount", target: "amount" }]);
  });

  it("Refused: a disallowed transform step, or an unmapped key column, returns a plain-language problem and no setup", () => {
    const withDisallowedStep: GraphDoc = (() => {
      const graph = allowedGraph();
      const dropNode = node({ id: "drop", type: "transform", config: { steps: [{ kind: "drop_fields", fields: ["amount"] }] } });
      return {
        nodes: [...graph.nodes, dropNode],
        edges: [{ id: "e1", source: "src", target: "drop" }, { id: "e2", source: "drop", target: "dest" }],
      };
    })();
    const stepResult = deriveAgentJobSetupFromGraph(withDisallowedStep);
    expect(stepResult.ok).toBe(false);
    if (!stepResult.ok) expect(stepResult.problems.some((p) => p.includes("drop_fields"))).toBe(true);

    const withUnmappedKey: GraphDoc = (() => {
      const graph = allowedGraph();
      const destIndex = graph.nodes.findIndex((n) => n.id === "dest");
      graph.nodes[destIndex] = {
        ...graph.nodes[destIndex]!,
        config: {
          mapping: { version: 1, entries: [{ from: "amount", to: "amount" }], approvedAt: null },
          delivery: { mode: "replace" },
        },
      };
      return graph;
    })();
    const keyResult = deriveAgentJobSetupFromGraph(withUnmappedKey);
    expect(keyResult.ok).toBe(false);
    if (!keyResult.ok) expect(keyResult.problems.some((p) => p.includes("key column") && p.includes("id"))).toBe(true);
  });
});

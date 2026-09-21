import { describe, expect, it } from "vitest";
import type { GraphDoc } from "./graph.js";
import {
  applyDiffToGraph,
  checkRevertConflicts,
  deepEqual,
  invertDiff,
  validateDiffStructure,
  type PlanDiff,
} from "./planDiff.js";

/**
 * Phase 12 unit tests (docs/plans/phase12.md Step 3) — the pure,
 * no-I/O layer only. The apply-path service test (apply a plan, revert
 * it, graphVersion bumps twice, two audit entries) lives in apps/api's
 * copilotDiffApply.test.ts since it needs a fake Supabase client.
 */

const s1Before = { kind: "filter" as const, expr: { kind: "literal" as const, value: true }, id: "s1" };

function baseGraph(): GraphDoc {
  return {
    nodes: [
      { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} },
      {
        id: "n2",
        type: "transform",
        position: { x: 100, y: 0 },
        config: { steps: [s1Before] },
      },
      { id: "n3", type: "destination", position: { x: 200, y: 0 }, config: {} },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  };
}

describe("planDiff round trip — every op kind", () => {
  it("applies a diff containing each op kind then reverts it; the graph deep-equals the original", () => {
    const original = baseGraph();

    const addedNode = { id: "n4", type: "transform" as const, position: { x: 300, y: 0 }, config: { steps: [] } };
    const addedStep = { kind: "computed_field" as const, name: "x", expression: { kind: "literal" as const, value: 1 } };

    const diff: PlanDiff = {
      summary: "exercise every op kind",
      baseGraphVersion: 1,
      ops: [
        // addNode
        { kind: "addNode", node: addedNode },
        // addEdge (wires the new node in)
        { kind: "addEdge", edge: { id: "e3", source: "n2", target: "n4" } },
        // addStep on the new node
        { kind: "addStep", nodeId: "n4", stepId: "s2", step: addedStep, index: 0 },
        // updateStep on n2's existing step
        {
          kind: "updateStep",
          nodeId: "n2",
          stepId: "s1",
          before: s1Before,
          after: { kind: "filter", expr: { kind: "literal", value: false }, id: "s1" },
        },
        // moveStep — add a second step to n2 first via addStep, then move it
        { kind: "addStep", nodeId: "n2", stepId: "s3", step: { kind: "drop_fields", fields: ["a"] }, index: 1 },
        { kind: "moveStep", nodeId: "n2", stepId: "s3", fromIndex: 1, toIndex: 0 },
        // updateNode
        {
          kind: "updateNode",
          nodeId: "n3",
          before: original.nodes[2]!,
          after: { ...original.nodes[2]!, position: { x: 250, y: 50 } },
        },
        // removeStep — remove the step we just moved
        { kind: "removeStep", nodeId: "n2", stepId: "s3", before: { kind: "drop_fields", fields: ["a"], id: "s3" }, index: 0 },
        // removeEdge + removeNode — remove n3 and its inbound edge. n3 was
        // just updated above, so its "before" snapshot here must be the
        // updated state, not the original — same rule applyOp enforces for
        // any op chain touching the same element twice.
        { kind: "removeEdge", edgeId: "e2", before: original.edges[1]! },
        { kind: "removeNode", nodeId: "n3", before: { ...original.nodes[2]!, position: { x: 250, y: 50 } } },
      ],
    };

    const checks = validateDiffStructure(diff, original);
    expect(checks.every((c) => c.status === "pass")).toBe(true);

    const applied = applyDiffToGraph(diff, original);
    expect(deepEqual(applied, original)).toBe(false);

    const revert = invertDiff(diff, { baseGraphVersion: 2 });
    const revertChecks = validateDiffStructure(revert, applied);
    expect(revertChecks.every((c) => c.status === "pass")).toBe(true);

    const reverted = applyDiffToGraph(revert, applied);
    expect(deepEqual(reverted, original)).toBe(true);
  });
});

describe("checkRevertConflicts", () => {
  it("refuses when a touched step was edited after apply, naming that step", () => {
    const original = baseGraph();
    const diff: PlanDiff = {
      summary: "update n2's filter",
      baseGraphVersion: 1,
      ops: [
        {
          kind: "updateStep",
          nodeId: "n2",
          stepId: "s1",
          before: s1Before,
          after: { kind: "filter", expr: { kind: "literal", value: false }, id: "s1" },
        },
      ],
    };

    const afterApply = applyDiffToGraph(diff, original);

    // Simulate a manual edit to the same step after the plan was applied.
    const driftedGraph: GraphDoc = {
      ...afterApply,
      nodes: afterApply.nodes.map((n) =>
        n.id === "n2"
          ? { ...n, config: { steps: [{ kind: "filter", expr: { kind: "literal", value: true }, id: "s1" }] } }
          : n,
      ),
    };

    const result = checkRevertConflicts(diff, driftedGraph);
    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.includes('"s1"') && c.includes('"n2"'))).toBe(true);
  });

  it("allows revert when nothing changed since apply", () => {
    const original = baseGraph();
    const diff: PlanDiff = {
      summary: "no-op check",
      baseGraphVersion: 1,
      ops: [
        {
          kind: "updateNode",
          nodeId: "n3",
          before: original.nodes[2]!,
          after: { ...original.nodes[2]!, position: { x: 250, y: 50 } },
        },
      ],
    };
    const afterApply = applyDiffToGraph(diff, original);
    const result = checkRevertConflicts(diff, afterApply);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
  });
});

describe("validateDiffStructure — dangling edge", () => {
  it("fails when removeNode isn't accompanied by removeEdge for its edges", () => {
    const original = baseGraph();
    const diff: PlanDiff = {
      summary: "remove n3 without removing e2",
      baseGraphVersion: 1,
      ops: [{ kind: "removeNode", nodeId: "n3", before: original.nodes[2]! }],
    };

    const checks = validateDiffStructure(diff, original);
    expect(checks.some((c) => c.status === "fail" && c.message.includes("removeEdge"))).toBe(true);
  });

  it("passes when removeNode is paired with removeEdge for every touching edge", () => {
    const original = baseGraph();
    const diff: PlanDiff = {
      summary: "remove n3 and e2 together",
      baseGraphVersion: 1,
      ops: [
        { kind: "removeEdge", edgeId: "e2", before: original.edges[1]! },
        { kind: "removeNode", nodeId: "n3", before: original.nodes[2]! },
      ],
    };

    const checks = validateDiffStructure(diff, original);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });
});

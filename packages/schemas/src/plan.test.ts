import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_AGGREGATE_ROWS,
  PLAN_AGGREGATE_HEADROOM,
  PLAN_AGGREGATE_REFUSAL_THRESHOLD,
  validatePlanFeasibility,
  type Plan,
  type PlanFeasibilityContext,
} from "./plan.js";

/**
 * Cheap, no-LLM unit tests for validatePlanFeasibility's cardinality-probe
 * decision logic — the injected entityExists/probeCardinality callbacks are
 * hand-rolled here rather than going through the real dispatch/connector
 * path, same "test the pure decision logic directly" precedent as
 * checks.test.ts's checkGrants suite.
 */

const noEntityChecks: PlanFeasibilityContext["entityExists"] = async () => true;

function planWithAggregate(groupBy: string[]): Plan {
  return {
    summary: "test plan",
    probeResults: [],
    baseGraphVersion: 0,
    nodes: [
      {
        id: "src-1",
        type: "source",
        connectionId: "11111111-1111-1111-1111-111111111111",
        config: { operation: "read", entity: { namespace: "public", name: "widgets" } },
        position: { x: 0, y: 0 },
      },
      {
        id: "xform-1",
        type: "transform",
        config: { steps: [{ kind: "aggregate", groupBy, aggregations: [{ fn: "count", field: null, alias: "c" }] }] },
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "src-1", target: "xform-1" }],
  };
}

describe("validatePlanFeasibility — cardinality probe outcomes", () => {
  it("passes and records evidence when comfortably within the cap", async () => {
    const plan = planWithAggregate(["id"]);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      probeCardinality: async () => 10,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0]).toMatchObject({ planNodeId: "xform-1", stepIndex: 0, observedCount: 10 });
    expect(typeof probeResults[0]!.probedAt).toBe("string");
  });

  it("refuses a hard breach (count > MAX_PLAN_AGGREGATE_ROWS)", async () => {
    const plan = planWithAggregate(["id"]);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      probeCardinality: async () => MAX_PLAN_AGGREGATE_ROWS + 1,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    const fail = results.find((r) => r.status === "fail");
    expect(fail?.message).toContain("row cap");
    expect(fail?.message).toContain("exceeding the");
    expect(probeResults).toHaveLength(0);
  });

  it("refuses inside the headroom margin (under the hard cap) with a message distinguishable from a hard breach", async () => {
    const plan = planWithAggregate(["id"]);
    const withinMarginCount = MAX_PLAN_AGGREGATE_ROWS - Math.floor(PLAN_AGGREGATE_HEADROOM / 2);
    expect(withinMarginCount).toBeGreaterThan(PLAN_AGGREGATE_REFUSAL_THRESHOLD);
    expect(withinMarginCount).toBeLessThanOrEqual(MAX_PLAN_AGGREGATE_ROWS);

    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      probeCardinality: async () => withinMarginCount,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    const fail = results.find((r) => r.status === "fail");
    expect(fail?.message).toContain("row cap");
    expect(fail?.message).toContain("safety margin");
    expect(fail?.message).not.toContain("exceeding the");
    expect(probeResults).toHaveLength(0);
  });

  it("refuses (never fails open) when the probe returns a negative 'unmeasured' sentinel", async () => {
    const plan = planWithAggregate(["id"]);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      probeCardinality: async () => -1,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    const fail = results.find((r) => r.status === "fail");
    expect(fail?.status).toBe("fail");
    expect(fail?.message).toContain("row cap");
    expect(fail?.message).toContain("could not be measured");
    expect(probeResults).toHaveLength(0);
  });
});

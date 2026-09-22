import { describe, expect, it } from "vitest";
import {
  RESIDUAL_PLAN_AGGREGATE_GROUP_CAP,
  validatePlanFeasibility,
  type Plan,
  type PlanFeasibilityContext,
} from "./plan.js";
import { parseExpression } from "./expression.js";
import type { Expr } from "./expression.js";

/**
 * Cheap, no-LLM unit tests for validatePlanFeasibility's cardinality-probe
 * decision logic — the injected entityExists/probeCardinality/resolveDialect
 * callbacks are hand-rolled here rather than going through the real
 * dispatch/connector path, same "test the pure decision logic directly"
 * precedent as checks.test.ts's checkGrants suite.
 *
 * Phase 13 gate correction: the cap only ever applies to a RESIDUAL (not
 * pushed-down) aggregate step — see RESIDUAL_PLAN_AGGREGATE_GROUP_CAP's doc
 * comment (plan.ts). A no-`having` aggregate is always pushable, so these
 * tests force a step residual via an unpushable `having` (regex_extract,
 * unsupported on mysql per FN_PUSHABILITY — ops/types.ts) whenever the test
 * needs to exercise the probe/cap path.
 */

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const noEntityChecks: PlanFeasibilityContext["entityExists"] = async () => true;
const mysqlDialect: PlanFeasibilityContext["resolveDialect"] = () => "mysql";

function expr(src: string): Expr {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
}

/** unpushable-on-mysql having, forcing splitPushable to classify the aggregate step residual regardless of the resolved dialect. */
const unpushableHaving = expr('regex_extract(c, "[0-9]+") != ""');

function planWithAggregate(groupBy: string[], having?: Expr): Plan {
  return {
    summary: "test plan",
    probeResults: [],
    baseGraphVersion: 0,
    nodes: [
      {
        id: "src-1",
        type: "source",
        connectionId: CONNECTION_ID,
        config: { operation: "read", entity: { namespace: "public", name: "widgets" } },
        position: { x: 0, y: 0 },
      },
      {
        id: "xform-1",
        type: "transform",
        config: {
          steps: [
            {
              kind: "aggregate",
              groupBy,
              aggregations: [{ fn: "count", field: null, alias: "c" }],
              ...(having ? { having } : {}),
            },
          ],
        },
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "src-1", target: "xform-1" }],
  };
}

describe("validatePlanFeasibility — pushed aggregates (no cap)", () => {
  it("never probes, and passes regardless of group count, for a pushed (no-having) aggregate", async () => {
    const plan = planWithAggregate(["id"]);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: mysqlDialect,
      probeCardinality: async () => {
        throw new Error("probeCardinality must not be called for a pushed aggregate");
      },
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(probeResults).toHaveLength(0);
  });

  it("an unresolvable dialect makes the step residual (compilePushdown's null-dialect contract: nothing is pushable), so it IS probed and capped", async () => {
    const plan = planWithAggregate(["id"]);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: () => null,
      probeCardinality: async () => 10,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(probeResults).toHaveLength(1);
  });
});

describe("validatePlanFeasibility — residual aggregates (RESIDUAL_PLAN_AGGREGATE_GROUP_CAP)", () => {
  it("passes and records evidence when comfortably within the cap", async () => {
    const plan = planWithAggregate(["id"], unpushableHaving);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: mysqlDialect,
      probeCardinality: async () => 10,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0]).toMatchObject({ planNodeId: "xform-1", stepIndex: 0, observedCount: 10 });
    expect(typeof probeResults[0]!.probedAt).toBe("string");
  });

  it("refuses a breach (count > RESIDUAL_PLAN_AGGREGATE_GROUP_CAP)", async () => {
    const plan = planWithAggregate(["id"], unpushableHaving);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: mysqlDialect,
      probeCardinality: async () => RESIDUAL_PLAN_AGGREGATE_GROUP_CAP + 1,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    const fail = results.find((r) => r.status === "fail");
    expect(fail?.message).toContain("group cap");
    expect(fail?.message).toContain("exceeding the");
    expect(probeResults).toHaveLength(0);
  });

  it("refuses (never fails open) when the probe returns a negative 'unmeasured' sentinel", async () => {
    const plan = planWithAggregate(["id"], unpushableHaving);
    const ctx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: mysqlDialect,
      probeCardinality: async () => -1,
    };
    const { results, probeResults } = await validatePlanFeasibility(plan, ctx);
    const fail = results.find((r) => r.status === "fail");
    expect(fail?.status).toBe("fail");
    expect(fail?.message).toContain("group cap");
    expect(fail?.message).toContain("could not be measured");
    expect(probeResults).toHaveLength(0);
  });

  it("honors ctx.residualGroupCap as a test-only override of RESIDUAL_PLAN_AGGREGATE_GROUP_CAP", async () => {
    const plan = planWithAggregate(["id"], unpushableHaving);
    const withinOverrideCtx: PlanFeasibilityContext = {
      entityExists: noEntityChecks,
      resolveDialect: mysqlDialect,
      probeCardinality: async () => 50,
      residualGroupCap: 50,
    };
    const withinResult = await validatePlanFeasibility(plan, withinOverrideCtx);
    expect(withinResult.results.every((r) => r.status === "pass")).toBe(true);

    const breachOverrideCtx: PlanFeasibilityContext = {
      ...withinOverrideCtx,
      probeCardinality: async () => 51,
    };
    const breachResult = await validatePlanFeasibility(plan, breachOverrideCtx);
    const fail = breachResult.results.find((r) => r.status === "fail");
    expect(fail?.message).toContain("50-group cap");
    expect(fail?.message).not.toContain(String(RESIDUAL_PLAN_AGGREGATE_GROUP_CAP));
  });
});

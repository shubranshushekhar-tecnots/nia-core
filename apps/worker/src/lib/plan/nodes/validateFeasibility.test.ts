import { describe, expect, it, vi } from "vitest";
import type { Plan } from "@nia/schemas";
import type { VisibleConnection } from "../listConnections.js";
import type { PlanStateType } from "../state.js";

/**
 * Worker-layer wiring test for validateFeasibilityNode — complements
 * packages/schemas/src/plan.test.ts (which proves validatePlanFeasibility's
 * pure decision logic in isolation via hand-rolled callbacks) by proving the
 * *real* probeCardinalityFn closure this node builds correctly plumbs a
 * dispatch failure through to a refusal.
 *
 * This exists specifically because a golden-suite case for "the cardinality
 * probe times out/errors" turned out to be unforceable through the live LLM
 * (every phrasing tried, including an explicit non-negotiable instruction to
 * emit a nonexistent groupBy column, reliably yields a `clarify` response
 * instead — the model won't emit a column it knows isn't in the introspected
 * schema). Same fallback the review itself authorized for the one-retry
 * path (nodes/shared.test.ts): test the logic directly rather than fight
 * LLM judgement calls with prompt wording.
 *
 * Mocks only the true I/O edges (resolveConnection, introspection,
 * probeCardinality), same mocking-boundary convention as
 * chat/multiSource/graph.test.ts — validatePlanFeasibility itself
 * (packages/schemas) runs for real.
 */

const resolveConnectionMock = vi.fn();
vi.mock("../../resolveConnection.js", () => ({ resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args) }));

const getSchemaMock = vi.fn();
vi.mock("../../introspection.js", () => ({ getSchema: (...args: unknown[]) => getSchemaMock(...args) }));

const probeCardinalityMock = vi.fn();
vi.mock("../probeCardinality.js", () => ({ probeCardinality: (...args: unknown[]) => probeCardinalityMock(...args) }));

const { validateFeasibilityNode } = await import("./validateFeasibility.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const SCOPE = { orgId: "org-1" };
const USER_ID = "44444444-4444-4444-4444-444444444444";

const connections: VisibleConnection[] = [{ id: CONNECTION_ID, handle: "@mysql-eval", connectorId: "mysql", dialect: "mysql" }];

function planWithAggregate(): Plan {
  return {
    summary: "test plan",
    probeResults: [],
    baseGraphVersion: 0,
    nodes: [
      {
        id: "src-1",
        type: "source",
        connectionId: CONNECTION_ID,
        config: { operation: "read", entity: { namespace: "public", name: "employees" } },
        position: { x: 0, y: 0 },
      },
      {
        id: "xform-1",
        type: "transform",
        config: { steps: [{ kind: "aggregate", groupBy: ["id"], aggregations: [{ fn: "count", field: null, alias: "c" }] }] },
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "src-1", target: "xform-1" }],
  };
}

function baseState(planGenAttempts: number): PlanStateType {
  return {
    plan: planWithAggregate(),
    connections,
    scope: SCOPE,
    userId: USER_ID,
    planGenAttempts,
  } as PlanStateType;
}

describe("validateFeasibilityNode — probe-error wiring", () => {
  it("refuses (capacity-limit) when the real probeCardinality closure reports 'unmeasured' (-1), never fails open", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: { id: CONNECTION_ID } });
    getSchemaMock.mockResolvedValue({
      ok: true,
      value: { entities: [{ namespace: "public", name: "employees", fields: [], primaryKey: null }] },
    });
    probeCardinalityMock.mockResolvedValue(-1);

    const result = await validateFeasibilityNode(baseState(2));

    expect(probeCardinalityMock).toHaveBeenCalledWith(CONNECTION_ID, { namespace: "public", name: "employees" }, ["id"], "mysql", SCOPE, USER_ID);
    expect(result.lastValidationOutcome).toBe("refused");
    expect(result.refusalKind).toBe("capacity-limit");
    expect(result.error).toContain("could not be measured");
  });

  it("retries (not refuse) on the first attempt, still carrying the probe-error message", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: { id: CONNECTION_ID } });
    getSchemaMock.mockResolvedValue({
      ok: true,
      value: { entities: [{ namespace: "public", name: "employees", fields: [], primaryKey: null }] },
    });
    probeCardinalityMock.mockResolvedValue(-1);

    const result = await validateFeasibilityNode(baseState(1));

    expect(result.lastValidationOutcome).toBe("retry");
    expect(result.feedback).toContain("could not be measured");
  });

  it("passes and carries probe evidence onto the returned plan when the probe succeeds within cap", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: { id: CONNECTION_ID } });
    getSchemaMock.mockResolvedValue({
      ok: true,
      value: { entities: [{ namespace: "public", name: "employees", fields: [], primaryKey: null }] },
    });
    probeCardinalityMock.mockResolvedValue(10);

    const result = await validateFeasibilityNode(baseState(1));

    expect(result.lastValidationOutcome).toBe("ok");
    expect(result.plan?.probeResults).toHaveLength(1);
    expect(result.plan?.probeResults[0]).toMatchObject({ planNodeId: "xform-1", observedCount: 10 });
  });
});

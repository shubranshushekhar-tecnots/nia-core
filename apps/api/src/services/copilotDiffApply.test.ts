import { describe, it, expect } from "vitest";
import type { GraphDoc as GraphDocType, PlanDiff as PlanDiffType } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
import { applyPlanDiff, revertPlan, listAppliedPlans } from "./copilotDiffApply.js";

type AppliedPlanRow = {
  id: string;
  workflow_id: string;
  summary: string;
  prompt: string;
  diff: unknown;
  graph_version_after: number;
  applied_at: string;
  applied_by: string | null;
  reverted_at: string | null;
  reverted_by: string | null;
  revert_plan_id: string | null;
  reverts_plan_id: string | null;
};

/**
 * Hand-rolled fake standing in for the raw-SQL calls applyPlanDiff/
 * revertPlan/listAppliedPlans's dependencies issue — same style as
 * copilotApply.test.ts's fake, extended to cover copilot_applied_plans
 * (the two distinct insert shapes: applyPlanDiff's explicit-id insert vs.
 * revertPlan's `returning id` insert; the by-id fetch; the ordered list)
 * and the two audit functions (log_plan_diff_applied, mark_plan_reverted).
 */
function createFakeWithUser(state: {
  workflowExists?: boolean;
  graphRow: { workflow_id: string; graph: GraphDocType; version: number } | null;
  rpcError?: { message: string } | null;
  rpcErrorFn?: string;
}) {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const workflowExists = state.workflowExists ?? true;
  const appliedPlans: AppliedPlanRow[] = [];
  let nextId = 1;

  const withUser: WithUser = (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });

        if (text.includes("from workflows where id")) {
          return { rowCount: workflowExists ? 1 : 0, rows: [] } as never;
        }

        if (text.includes("select graph, version from workflow_graphs")) {
          return {
            rows: state.graphRow ? [{ graph: state.graphRow.graph, version: state.graphRow.version }] : [],
          } as never;
        }

        if (text.includes("update workflow_graphs set graph")) {
          const [graph, , expectedVersion] = params as [GraphDocType, string, number];
          if (!state.graphRow || state.graphRow.version !== expectedVersion) return { rows: [] } as never;
          state.graphRow = { ...state.graphRow, graph, version: state.graphRow.version + 1 };
          return { rows: [{ graph: state.graphRow.graph, version: state.graphRow.version }] } as never;
        }

        if (text.includes("select node_id, steps_hash from clean_plans")) {
          // No test in this file exercises CleanPlan bindings — an empty
          // result lets putWorkflowGraph's unbindStaleCleanPlans no-op.
          return { rows: [] } as never;
        }

        if (text.includes("delete from clean_plans")) {
          return { rows: [] } as never;
        }

        // applyPlanDiff's insert — explicit pre-generated id, no RETURNING
        // (Phase 12 provenance stamping needs the id before the row exists).
        if (text.includes("insert into copilot_applied_plans (id,")) {
          const [id, workflowId, summary, prompt, diff, graphVersionAfter] = params as [
            string,
            string,
            string,
            string,
            unknown,
            number,
          ];
          appliedPlans.push({
            id,
            workflow_id: workflowId,
            summary,
            prompt,
            diff,
            graph_version_after: graphVersionAfter,
            applied_at: "2026-01-01T00:00:00.000Z",
            applied_by: "user-1",
            reverted_at: null,
            reverted_by: null,
            revert_plan_id: null,
            reverts_plan_id: null,
          });
          return { rows: [] } as never;
        }

        // revertPlan's insert — no explicit id, `returning id` (mirrors a
        // real db-generated primary key).
        if (text.includes("insert into copilot_applied_plans (workflow_id,")) {
          const [workflowId, summary, prompt, diff, graphVersionAfter, revertsPlanId] = params as [
            string,
            string,
            string,
            unknown,
            number,
            string,
          ];
          const id = `applied-${nextId++}`;
          appliedPlans.push({
            id,
            workflow_id: workflowId,
            summary,
            prompt,
            diff,
            graph_version_after: graphVersionAfter,
            applied_at: "2026-01-01T00:00:00.000Z",
            applied_by: "user-1",
            reverted_at: null,
            reverted_by: null,
            revert_plan_id: null,
            reverts_plan_id: revertsPlanId,
          });
          return { rows: [{ id }] } as never;
        }

        if (text.includes("from copilot_applied_plans where id = $1 and workflow_id = $2")) {
          const [id, workflowId] = params as [string, string];
          const row = appliedPlans.find((r) => r.id === id && r.workflow_id === workflowId);
          return { rows: row ? [row] : [] } as never;
        }

        if (text.includes("from copilot_applied_plans where workflow_id = $1 order by applied_at desc")) {
          const [workflowId, limit] = params as [string, number];
          const rows = appliedPlans
            .filter((r) => r.workflow_id === workflowId)
            .slice()
            .reverse()
            .slice(0, limit);
          return { rows } as never;
        }

        if (text.includes("select public.log_plan_diff_applied")) {
          if (state.rpcError && (!state.rpcErrorFn || state.rpcErrorFn === "log_plan_diff_applied")) {
            throw new Error(state.rpcError.message);
          }
          return { rows: [] } as never;
        }

        if (text.includes("select public.mark_plan_reverted")) {
          if (state.rpcError && (!state.rpcErrorFn || state.rpcErrorFn === "mark_plan_reverted")) {
            throw new Error(state.rpcError.message);
          }
          const [planId, revertPlanId] = params as [string, string];
          const plan = appliedPlans.find((r) => r.id === planId);
          if (plan) {
            plan.reverted_at = "2026-01-02T00:00:00.000Z";
            plan.reverted_by = "user-1";
            plan.revert_plan_id = revertPlanId;
          }
          return { rows: [] } as never;
        }

        throw new Error(`unexpected query in fake: ${text}`);
      },
    })) as WithUser;

  return {
    withUser,
    queries,
    getGraphRow: () => state.graphRow,
    setGraphRow: (row: { workflow_id: string; graph: GraphDocType; version: number }) => {
      state.graphRow = row;
    },
    getAppliedPlans: () => appliedPlans,
  };
}

const scope = { ownerId: "user-1" };

describe("applyPlanDiff + revertPlan", () => {
  it("applies a diff then reverts it: graph restored, graphVersion bumps twice, two audit entries", async () => {
    const original: GraphDocType = {
      nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const { withUser, queries, getGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff: PlanDiffType = {
      summary: "add a destination",
      baseGraphVersion: 1,
      ops: [
        {
          kind: "addNode",
          node: { id: "n2", type: "destination", position: { x: 100, y: 0 }, config: {} },
        },
      ],
    };

    const applied = await applyPlanDiff(withUser, scope, "wf-1", { diff, prompt: "add a destination" });

    expect(applied.version).toBe(2);
    expect(applied.graph.nodes).toHaveLength(2);
    expect(getGraphRow()?.version).toBe(2);

    const reverted = await revertPlan(withUser, scope, "wf-1", applied.appliedPlanId, {});

    expect(reverted.version).toBe(3);
    expect(reverted.graph.nodes).toEqual(original.nodes);
    expect(reverted.graph.edges).toEqual(original.edges);
    expect(getGraphRow()?.version).toBe(3);

    // Two audit entries: one for the apply, one for the revert.
    const auditCalls = queries.filter((q) => q.text.includes("log_plan_diff_applied"));
    expect(auditCalls).toHaveLength(2);
    // Plus the mark_plan_reverted call linking the original plan to its revert.
    const markCalls = queries.filter((q) => q.text.includes("mark_plan_reverted"));
    expect(markCalls).toHaveLength(1);
    expect(markCalls[0]!.params).toEqual([applied.appliedPlanId, reverted.appliedPlanId, null]);
  });

  it("refuses a diff proposed against a stale graph version without writing anything", async () => {
    const original: GraphDocType = { nodes: [], edges: [] };
    const { withUser, queries, getGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 2 },
    });

    const diff: PlanDiffType = {
      summary: "stale diff",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 0, y: 0 }, config: {} } }],
    };

    await expect(applyPlanDiff(withUser, scope, "wf-1", { diff })).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_STALE",
    });

    expect(getGraphRow()?.version).toBe(2);
    expect(queries.filter((q) => q.text.includes("log_plan_diff_applied"))).toHaveLength(0);
  });

  it("refuses to revert a plan that's already been reverted", async () => {
    const original: GraphDocType = { nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    const { withUser } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff: PlanDiffType = {
      summary: "add a destination",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 100, y: 0 }, config: {} } }],
    };

    const applied = await applyPlanDiff(withUser, scope, "wf-1", { diff });
    await revertPlan(withUser, scope, "wf-1", applied.appliedPlanId, {});

    await expect(revertPlan(withUser, scope, "wf-1", applied.appliedPlanId, {})).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_ALREADY_REVERTED",
    });
  });

  it("refuses to revert when a touched node has since changed, naming the conflict", async () => {
    const original: GraphDocType = { nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    const { withUser, getGraphRow, setGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff: PlanDiffType = {
      summary: "move n1",
      baseGraphVersion: 1,
      ops: [
        {
          kind: "updateNode",
          nodeId: "n1",
          before: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} },
          after: { id: "n1", type: "source", position: { x: 50, y: 50 }, config: {} },
        },
      ],
    };

    const applied = await applyPlanDiff(withUser, scope, "wf-1", { diff });

    // Drift n1 again after the plan applied, without going through revert.
    const row = getGraphRow()!;
    setGraphRow({
      ...row,
      graph: { ...row.graph, nodes: [{ ...row.graph.nodes[0]!, position: { x: 999, y: 999 } }] },
      version: row.version + 1,
    });

    await expect(revertPlan(withUser, scope, "wf-1", applied.appliedPlanId, {})).rejects.toMatchObject({
      statusCode: 409,
      code: "REVERT_CONFLICT",
    });
  });

  it("names the drifted node in the REVERT_CONFLICT error's details, not just the code", async () => {
    // Distinct from both the plain conflict-refusal test above (which only
    // asserts statusCode/code) and the already-reverted test below (a
    // different code, PLAN_ALREADY_REVERTED, for a different scenario) —
    // this is the one assertion that the conflict actually names the
    // element that changed, at the service layer (checkRevertConflicts'
    // own naming is already covered at the pure-function level in
    // planDiff.test.ts).
    const original: GraphDocType = { nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    const { withUser, getGraphRow, setGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff: PlanDiffType = {
      summary: "move n1",
      baseGraphVersion: 1,
      ops: [
        {
          kind: "updateNode",
          nodeId: "n1",
          before: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} },
          after: { id: "n1", type: "source", position: { x: 50, y: 50 }, config: {} },
        },
      ],
    };

    const applied = await applyPlanDiff(withUser, scope, "wf-1", { diff });

    const row = getGraphRow()!;
    setGraphRow({
      ...row,
      graph: { ...row.graph, nodes: [{ ...row.graph.nodes[0]!, position: { x: 999, y: 999 } }] },
      version: row.version + 1,
    });

    let caught: unknown;
    try {
      await revertPlan(withUser, scope, "wf-1", applied.appliedPlanId, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as { code: string; details?: { conflicts?: string[] } };
    expect(err.code).toBe("REVERT_CONFLICT");
    expect(err.details?.conflicts?.length).toBeGreaterThan(0);
    expect(err.details?.conflicts?.some((c) => c.includes('"n1"'))).toBe(true);
  });

  it("surfaces a failed audit write as an error rather than silently dropping it", async () => {
    const original: GraphDocType = { nodes: [], edges: [] };
    const { withUser } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
      rpcError: { message: "boom" },
      rpcErrorFn: "log_plan_diff_applied",
    });

    const diff: PlanDiffType = {
      summary: "add a source",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} } }],
    };

    await expect(applyPlanDiff(withUser, scope, "wf-1", { diff })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("lists applied plans most-recent-first", async () => {
    const original: GraphDocType = { nodes: [], edges: [] };
    const { withUser } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff1: PlanDiffType = {
      summary: "first",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} } }],
    };
    await applyPlanDiff(withUser, scope, "wf-1", { diff: diff1 });

    const diff2: PlanDiffType = {
      summary: "second",
      baseGraphVersion: 2,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 100, y: 0 }, config: {} } }],
    };
    await applyPlanDiff(withUser, scope, "wf-1", { diff: diff2 });

    const list = await listAppliedPlans(withUser, scope, "wf-1");
    expect(list.map((p) => p.summary)).toEqual(["second", "first"]);
  });
});

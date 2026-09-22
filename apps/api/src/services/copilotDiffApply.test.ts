import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GraphDoc as GraphDocType, PlanDiff as PlanDiffType } from "@nia/schemas";
import { applyPlanDiff, revertPlan, listAppliedPlans } from "./copilotDiffApply.js";

/**
 * Hand-rolled fake standing in for the exact subset of the SupabaseClient
 * chain applyPlanDiff/revertPlan/listAppliedPlans's dependencies issue —
 * same style as copilotApply.test.ts's fake, extended to cover the
 * copilot_applied_plans table (select/insert) and the two new RPCs
 * (log_plan_diff_applied, mark_plan_reverted).
 */
function createFakeClient(state: {
  workflowExists?: boolean;
  graphRow: { workflow_id: string; graph: GraphDocType; version: number } | null;
  rpcError?: { message: string } | null;
  rpcErrorFn?: string;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const workflowExists = state.workflowExists ?? true;
  let appliedPlans: Array<Record<string, unknown>> = [];
  let nextId = 1;

  const client = {
    from(table: string) {
      if (table === "workflows") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ count: workflowExists ? 1 : 0 }),
              is: () => ({
                eq: () => Promise.resolve({ count: workflowExists ? 1 : 0 }),
              }),
            }),
          }),
        };
      }

      if (table === "workflow_graphs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                state.graphRow
                  ? { data: { graph: state.graphRow.graph, version: state.graphRow.version }, error: null }
                  : { data: null, error: null },
            }),
          }),
          update: (patch: { graph: GraphDocType }) => ({
            eq: () => ({
              eq: (_col: string, expectedVersion: number) => ({
                select: () => ({
                  maybeSingle: async () => {
                    if (!state.graphRow || state.graphRow.version !== expectedVersion) {
                      return { data: null, error: null };
                    }
                    state.graphRow = { ...state.graphRow, graph: patch.graph, version: state.graphRow.version + 1 };
                    return { data: { graph: state.graphRow.graph, version: state.graphRow.version }, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }

      if (table === "copilot_applied_plans") {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                // applyPlanDiff now pre-generates and passes an explicit
                // `id` (Phase 12 provenance stamping needs the id before
                // the row exists) — honor it like a real `insert` with an
                // explicit primary key would, instead of always minting a
                // fake-only id the caller's `appliedPlanId` would then
                // disagree with.
                const id = (row.id as string | undefined) ?? `applied-${nextId++}`;
                appliedPlans.push({
                  id,
                  workflow_id: row.workflow_id,
                  summary: row.summary,
                  prompt: row.prompt,
                  diff: row.diff,
                  graph_version_after: row.graph_version_after,
                  applied_at: "2026-01-01T00:00:00.000Z",
                  applied_by: "user-1",
                  reverted_at: null,
                  reverted_by: null,
                  revert_plan_id: null,
                  reverts_plan_id: row.reverts_plan_id ?? null,
                });
                return { data: { id }, error: null };
              },
            }),
          }),
          select: () => {
            const builder = {
              _eqs: {} as Record<string, unknown>,
              eq(col: string, value: unknown) {
                builder._eqs[col] = value;
                return builder;
              },
              maybeSingle: async () => {
                const row = appliedPlans.find((r) =>
                  Object.entries(builder._eqs).every(([k, v]) => r[k] === v),
                );
                return { data: row ?? null, error: null };
              },
              order: () => ({
                limit: async (n: number) =>
                  Promise.resolve({
                    data: appliedPlans
                      .filter((r) => Object.entries(builder._eqs).every(([k, v]) => r[k] === v))
                      .slice()
                      .reverse()
                      .slice(0, n),
                  }),
              }),
            };
            return builder;
          },
        };
      }

      if (table === "clean_plans") {
        // No test in this file exercises CleanPlan bindings — this fake
        // only needs to satisfy putWorkflowGraph's unbindStaleCleanPlans
        // lookup (workflowGraphs.ts) with an empty result so it no-ops.
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }

      throw new Error(`unexpected table "${table}" in fake`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (state.rpcError && (!state.rpcErrorFn || state.rpcErrorFn === fn)) {
        return { error: state.rpcError };
      }
      if (fn === "mark_plan_reverted") {
        const plan = appliedPlans.find((r) => r.id === args.p_plan_id);
        if (plan) {
          plan.reverted_at = "2026-01-02T00:00:00.000Z";
          plan.reverted_by = "user-1";
          plan.revert_plan_id = args.p_revert_plan_id;
        }
      }
      return { error: null };
    },
  };

  return {
    supabase: client as unknown as SupabaseClient,
    rpcCalls,
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
    const { supabase, rpcCalls, getGraphRow } = createFakeClient({
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

    const applied = await applyPlanDiff(supabase, scope, "wf-1", { diff, prompt: "add a destination" });

    expect(applied.version).toBe(2);
    expect(applied.graph.nodes).toHaveLength(2);
    expect(getGraphRow()?.version).toBe(2);

    const reverted = await revertPlan(supabase, scope, "wf-1", applied.appliedPlanId, {});

    expect(reverted.version).toBe(3);
    expect(reverted.graph.nodes).toEqual(original.nodes);
    expect(reverted.graph.edges).toEqual(original.edges);
    expect(getGraphRow()?.version).toBe(3);

    // Two audit entries: one for the apply, one for the revert.
    const auditCalls = rpcCalls.filter((c) => c.fn === "log_plan_diff_applied");
    expect(auditCalls).toHaveLength(2);
    // Plus the mark_plan_reverted call linking the original plan to its revert.
    const markCalls = rpcCalls.filter((c) => c.fn === "mark_plan_reverted");
    expect(markCalls).toHaveLength(1);
    expect(markCalls[0]!.args).toMatchObject({ p_plan_id: applied.appliedPlanId, p_revert_plan_id: reverted.appliedPlanId });
  });

  it("refuses a diff proposed against a stale graph version without writing anything", async () => {
    const original: GraphDocType = { nodes: [], edges: [] };
    const { supabase, rpcCalls, getGraphRow } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: original, version: 2 },
    });

    const diff: PlanDiffType = {
      summary: "stale diff",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 0, y: 0 }, config: {} } }],
    };

    await expect(applyPlanDiff(supabase, scope, "wf-1", { diff })).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_STALE",
    });

    expect(getGraphRow()?.version).toBe(2);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses to revert a plan that's already been reverted", async () => {
    const original: GraphDocType = { nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff: PlanDiffType = {
      summary: "add a destination",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 100, y: 0 }, config: {} } }],
    };

    const applied = await applyPlanDiff(supabase, scope, "wf-1", { diff });
    await revertPlan(supabase, scope, "wf-1", applied.appliedPlanId, {});

    await expect(revertPlan(supabase, scope, "wf-1", applied.appliedPlanId, {})).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_ALREADY_REVERTED",
    });
  });

  it("refuses to revert when a touched node has since changed, naming the conflict", async () => {
    const original: GraphDocType = { nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }], edges: [] };
    const { supabase, getGraphRow, setGraphRow } = createFakeClient({
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

    const applied = await applyPlanDiff(supabase, scope, "wf-1", { diff });

    // Drift n1 again after the plan applied, without going through revert.
    const row = getGraphRow()!;
    setGraphRow({
      ...row,
      graph: { ...row.graph, nodes: [{ ...row.graph.nodes[0]!, position: { x: 999, y: 999 } }] },
      version: row.version + 1,
    });

    await expect(revertPlan(supabase, scope, "wf-1", applied.appliedPlanId, {})).rejects.toMatchObject({
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
    const { supabase, getGraphRow, setGraphRow } = createFakeClient({
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

    const applied = await applyPlanDiff(supabase, scope, "wf-1", { diff });

    const row = getGraphRow()!;
    setGraphRow({
      ...row,
      graph: { ...row.graph, nodes: [{ ...row.graph.nodes[0]!, position: { x: 999, y: 999 } }] },
      version: row.version + 1,
    });

    let caught: unknown;
    try {
      await revertPlan(supabase, scope, "wf-1", applied.appliedPlanId, {});
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
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
      rpcError: { message: "boom" },
      rpcErrorFn: "log_plan_diff_applied",
    });

    const diff: PlanDiffType = {
      summary: "add a source",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} } }],
    };

    await expect(applyPlanDiff(supabase, scope, "wf-1", { diff })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("lists applied plans most-recent-first", async () => {
    const original: GraphDocType = { nodes: [], edges: [] };
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: original, version: 1 },
    });

    const diff1: PlanDiffType = {
      summary: "first",
      baseGraphVersion: 1,
      ops: [{ kind: "addNode", node: { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} } }],
    };
    await applyPlanDiff(supabase, scope, "wf-1", { diff: diff1 });

    const diff2: PlanDiffType = {
      summary: "second",
      baseGraphVersion: 2,
      ops: [{ kind: "addNode", node: { id: "n2", type: "destination", position: { x: 100, y: 0 }, config: {} } }],
    };
    await applyPlanDiff(supabase, scope, "wf-1", { diff: diff2 });

    const list = await listAppliedPlans(supabase, scope, "wf-1");
    expect(list.map((p) => p.summary)).toEqual(["second", "first"]);
  });
});

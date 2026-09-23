import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GraphDoc as GraphDocType } from "@nia/schemas";
import { applyPlan } from "./copilotApply.js";

/**
 * Hand-rolled fake standing in for the exact subset of the SupabaseClient
 * chain applyPlan's dependencies issue (getWorkflowGraph/putWorkflowGraph's
 * "workflows"/"workflow_graphs" reads+writes, listConnections' "connections"
 * read, and the log_plan_applied RPC) — same style as
 * workflowGraphs.race.test.ts's fake, extended to cover connections + rpc.
 */
function createFakeClient(state: {
  workflowExists?: boolean;
  graphRow: { workflow_id: string; graph: GraphDocType; version: number } | null;
  connections?: Array<{ id: string; connector_id: string }>;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const workflowExists = state.workflowExists ?? true;
  const connections = state.connections ?? [];

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
          upsert: (input: { workflow_id: string; graph: GraphDocType }) => ({
            select: () => ({
              maybeSingle: async () => {
                if (state.graphRow) return { data: null, error: null };
                state.graphRow = { workflow_id: input.workflow_id, graph: input.graph, version: 1 };
                return { data: { graph: state.graphRow.graph, version: state.graphRow.version }, error: null };
              },
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

      if (table === "connections") {
        const rows = connections.map((c) => ({
          id: c.id,
          connector_id: c.connector_id,
          handle: c.id,
          display_name: c.id,
          owner_user_id: "user-1",
          config: {},
          cred_version: 1,
          last_test_status: null,
          last_test_latency_ms: null,
          last_test_at: null,
          last_used_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }));
        const afterFilter = { order: async () => ({ data: rows }) };
        return {
          select: () => ({
            eq: () => afterFilter,
            is: () => ({ eq: () => afterFilter }),
          }),
        };
      }

      if (table === "clean_plans") {
        // Not exercised by this file — an empty result lets
        // putWorkflowGraph's unbindStaleCleanPlans no-op.
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
      return { error: state.rpcError ?? null };
    },
  };

  return { supabase: client as unknown as SupabaseClient, rpcCalls, getGraphRow: () => state.graphRow };
}

const scope = { ownerId: "user-1" };

describe("applyPlan", () => {
  it("rewrites plan-local node ids to real ids and resolves edges through the remap", async () => {
    const existingGraph: GraphDocType = {
      nodes: [{ id: "existing-1", type: "destination", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "add a source and a transform",
      baseGraphVersion: 1,
      nodes: [
        { id: "new-1", type: "source", config: {}, position: { x: 10, y: 10 } },
        { id: "new-2", type: "transform", config: { steps: [] }, position: { x: 20, y: 20 } },
      ],
      edges: [
        { id: "e1", source: "new-1", target: "new-2" },
        { id: "e2", source: "new-2", target: "existing-1" },
      ],
      probeResults: [],
    };

    const result = await applyPlan(supabase, scope, "wf-1", { plan });

    expect(result.graph.nodes).toHaveLength(3);
    expect(result.appliedNodeIds).toHaveLength(2);
    // Neither applied id is the plan-local id — both were remapped to fresh uuids.
    expect(result.appliedNodeIds).not.toContain("new-1");
    expect(result.appliedNodeIds).not.toContain("new-2");

    const [realSourceId, realTransformId] = result.appliedNodeIds;
    const persistedEdgeIds = result.graph.edges.map((e) => [e.source, e.target]);
    expect(persistedEdgeIds).toContainEqual([realSourceId, realTransformId]);
    expect(persistedEdgeIds).toContainEqual([realTransformId, "existing-1"]);

    // No leftover plan-local ids anywhere in the persisted graph.
    const allIds = result.graph.nodes.map((n) => n.id);
    expect(allIds).not.toContain("new-1");
    expect(allIds).not.toContain("new-2");
  });

  it("refuses a plan proposed against a stale graph version without writing anything", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { supabase, rpcCalls, getGraphRow } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 2 },
    });

    const plan = {
      summary: "stale plan",
      baseGraphVersion: 1, // graph has already moved to version 2
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    await expect(applyPlan(supabase, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_STALE",
    });

    // Nothing was mutated and no audit event was written.
    expect(getGraphRow()?.version).toBe(2);
    expect(rpcCalls).toHaveLength(0);
  });

  it("stamps validatePlanFeasibility's probe evidence onto the matching aggregate step's persisted config", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "add an aggregate",
      baseGraphVersion: 1,
      nodes: [
        {
          id: "new-agg",
          type: "transform",
          config: { steps: [{ kind: "aggregate", groupBy: ["country"] }] },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      probeResults: [
        { planNodeId: "new-agg", stepIndex: 0, groupBy: ["country"], observedCount: 42, probedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };

    const result = await applyPlan(supabase, scope, "wf-1", { plan });

    const persisted = result.graph.nodes.find((n) => n.type === "transform")!;
    const steps = persisted.config.steps as Array<Record<string, unknown>>;
    expect(steps[0]!.observedCount).toBe(42);
    expect(steps[0]!.probedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("writes the audit event with the applied (real) node ids, not the plan-local ones", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { supabase, rpcCalls } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "add a destination",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "destination", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    const result = await applyPlan(supabase, scope, "wf-1", { plan, prompt: "add a destination node" });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.fn).toBe("log_plan_applied");
    expect(rpcCalls[0]!.args).toMatchObject({
      p_workflow_id: "wf-1",
      p_plan_summary: "add a destination",
      p_prompt: "add a destination node",
      p_graph_version: result.version,
    });
    expect(rpcCalls[0]!.args.p_applied_node_ids).toEqual(result.appliedNodeIds);
    expect(rpcCalls[0]!.args.p_applied_node_ids).not.toContain("new-1");
  });

  it("surfaces a failed audit write as an error rather than silently dropping it (audit log is load-bearing)", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { supabase } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
      rpcError: { message: "boom" },
    });

    const plan = {
      summary: "add a source",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    await expect(applyPlan(supabase, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("rejects a structurally invalid plan (dangling edge target) before ever calling putWorkflowGraph", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { supabase, rpcCalls, getGraphRow } = createFakeClient({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "dangling edge",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [{ id: "e1", source: "new-1", target: "does-not-exist" }],
      probeResults: [],
    };

    await expect(applyPlan(supabase, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 422,
      code: "PLAN_INVALID",
    });
    expect(getGraphRow()?.version).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });
});

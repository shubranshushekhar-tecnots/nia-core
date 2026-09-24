import { describe, it, expect } from "vitest";
import type { GraphDoc as GraphDocType } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
import { applyPlan } from "./copilotApply.js";

/**
 * Hand-rolled fake standing in for the raw-SQL calls applyPlan's
 * dependencies issue (getWorkflowGraph/putWorkflowGraph's reads+writes,
 * listConnections' read, and the log_plan_applied audit call) — same
 * style as workflowGraphs.race.test.ts's fake, extended to cover
 * connections and the audit function. `queries` records every call so the
 * audit write's params can be asserted on (replaces the pre-migration
 * fake's `rpcCalls`).
 */
function createFakeWithUser(state: {
  workflowExists?: boolean;
  graphRow: { workflow_id: string; graph: GraphDocType; version: number } | null;
  connections?: Array<{ id: string; connector_id: string }>;
  auditError?: string;
}) {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const workflowExists = state.workflowExists ?? true;
  const connections = state.connections ?? [];

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

        if (text.includes("insert into workflow_graphs")) {
          if (state.graphRow) return { rows: [] } as never; // ON CONFLICT (workflow_id) DO NOTHING
          const [workflowId, graph] = params as [string, GraphDocType];
          state.graphRow = { workflow_id: workflowId, graph, version: 1 };
          return { rows: [{ graph: state.graphRow.graph, version: state.graphRow.version }] } as never;
        }

        if (text.includes("update workflow_graphs set graph")) {
          const [graph, , expectedVersion] = params as [GraphDocType, string, number];
          if (!state.graphRow || state.graphRow.version !== expectedVersion) return { rows: [] } as never;
          state.graphRow = { ...state.graphRow, graph, version: state.graphRow.version + 1 };
          return { rows: [{ graph: state.graphRow.graph, version: state.graphRow.version }] } as never;
        }

        if (text.includes("select node_id, steps_hash from clean_plans")) {
          // Not exercised by this file — an empty result lets
          // putWorkflowGraph's unbindStaleCleanPlans no-op.
          return { rows: [] } as never;
        }

        if (text.includes("delete from clean_plans")) {
          return { rows: [] } as never;
        }

        if (text.includes("from connections where")) {
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
          return { rows } as never;
        }

        if (text.includes("select public.log_plan_applied")) {
          if (state.auditError) throw new Error(state.auditError);
          return { rows: [] } as never;
        }

        throw new Error(`unexpected query in fake: ${text}`);
      },
    })) as WithUser;

  return { withUser, queries, getGraphRow: () => state.graphRow };
}

const scope = { ownerId: "user-1" };

describe("applyPlan", () => {
  it("rewrites plan-local node ids to real ids and resolves edges through the remap", async () => {
    const existingGraph: GraphDocType = {
      nodes: [{ id: "existing-1", type: "destination", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const { withUser } = createFakeWithUser({
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

    const result = await applyPlan(withUser, scope, "wf-1", { plan });

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
    const { withUser, queries, getGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 2 },
    });

    const plan = {
      summary: "stale plan",
      baseGraphVersion: 1, // graph has already moved to version 2
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    await expect(applyPlan(withUser, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 409,
      code: "PLAN_STALE",
    });

    // Nothing was mutated and no audit event was written.
    expect(getGraphRow()?.version).toBe(2);
    expect(queries.filter((q) => q.text.includes("log_plan_applied"))).toHaveLength(0);
  });

  it("stamps validatePlanFeasibility's probe evidence onto the matching aggregate step's persisted config", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { withUser } = createFakeWithUser({
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

    const result = await applyPlan(withUser, scope, "wf-1", { plan });

    const persisted = result.graph.nodes.find((n) => n.type === "transform")!;
    const steps = persisted.config.steps as Array<Record<string, unknown>>;
    expect(steps[0]!.observedCount).toBe(42);
    expect(steps[0]!.probedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("writes the audit event with the applied (real) node ids, not the plan-local ones", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { withUser, queries } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "add a destination",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "destination", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    const result = await applyPlan(withUser, scope, "wf-1", { plan, prompt: "add a destination node" });

    const auditCalls = queries.filter((q) => q.text.includes("log_plan_applied"));
    expect(auditCalls).toHaveLength(1);
    const [pWorkflowId, pSummary, pPrompt, pAppliedNodeIds, pGraphVersion] = auditCalls[0]!.params as [
      string,
      string,
      string | null,
      string[],
      number,
    ];
    expect(pWorkflowId).toBe("wf-1");
    expect(pSummary).toBe("add a destination");
    expect(pPrompt).toBe("add a destination node");
    expect(pGraphVersion).toBe(result.version);
    expect(pAppliedNodeIds).toEqual(result.appliedNodeIds);
    expect(pAppliedNodeIds).not.toContain("new-1");
  });

  it("surfaces a failed audit write as an error rather than silently dropping it (audit log is load-bearing)", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { withUser } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
      auditError: "boom",
    });

    const plan = {
      summary: "add a source",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      probeResults: [],
    };

    await expect(applyPlan(withUser, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("rejects a structurally invalid plan (dangling edge target) before ever calling putWorkflowGraph", async () => {
    const existingGraph: GraphDocType = { nodes: [], edges: [] };
    const { withUser, queries, getGraphRow } = createFakeWithUser({
      graphRow: { workflow_id: "wf-1", graph: existingGraph, version: 1 },
    });

    const plan = {
      summary: "dangling edge",
      baseGraphVersion: 1,
      nodes: [{ id: "new-1", type: "source", config: {}, position: { x: 0, y: 0 } }],
      edges: [{ id: "e1", source: "new-1", target: "does-not-exist" }],
      probeResults: [],
    };

    await expect(applyPlan(withUser, scope, "wf-1", { plan })).rejects.toMatchObject({
      statusCode: 422,
      code: "PLAN_INVALID",
    });
    expect(getGraphRow()?.version).toBe(1);
    expect(queries.filter((q) => q.text.includes("log_plan_applied"))).toHaveLength(0);
  });
});

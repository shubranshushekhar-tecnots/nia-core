import { describe, it, expect } from "vitest";
import type { GraphDoc as GraphDocType } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { putWorkflowGraph } from "./workflowGraphs.js";

/**
 * Hand-rolled fake standing in for the raw-SQL calls putWorkflowGraph
 * issues, backed by a single in-memory row that mimics workflow_graphs'
 * real constraints from 0012_workflow_graphs.sql: `INSERT ... ON CONFLICT
 * (workflow_id) DO NOTHING RETURNING ...` for the first-save path, and a
 * conditional `UPDATE ... WHERE version = :expected RETURNING ...` for
 * every later save. Each query resolves its winner/loser decision
 * synchronously at the point it's issued, mirroring how a real query
 * resolves eagerly once sent — so racing two putWorkflowGraph() calls via
 * Promise.allSettled deterministically reproduces the two-tab first-save
 * race called out on review, without a live Postgres instance.
 */
function createFakeWorkflowGraphsClient(): { withUser: WithUser } {
  let row: { workflow_id: string; graph: unknown; version: number } | null = null;

  const withUser: WithUser = (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        if (text.includes("from workflows where id")) {
          return { rowCount: 1, rows: [] } as never;
        }

        if (text.includes("select node_id, steps_hash from clean_plans")) {
          // Not exercised by this race test — an empty result lets
          // putWorkflowGraph's unbindStaleCleanPlans no-op.
          return { rows: [] } as never;
        }

        if (text.includes("insert into workflow_graphs")) {
          if (row) return { rows: [] } as never; // ON CONFLICT (workflow_id) DO NOTHING
          const [workflowId, graph] = params as [string, unknown];
          row = { workflow_id: workflowId, graph, version: 1 };
          return { rows: [{ graph: row.graph, version: row.version }] } as never;
        }

        if (text.includes("update workflow_graphs set graph")) {
          const [graph, , expectedVersion] = params as [unknown, string, number];
          if (!row || row.version !== expectedVersion) return { rows: [] } as never;
          row = { ...row, graph, version: row.version + 1 };
          return { rows: [{ graph: row.graph, version: row.version }] } as never;
        }

        throw new Error(`unexpected query in fake: ${text}`);
      },
    })) as WithUser;

  return { withUser };
}

describe("putWorkflowGraph — first-save race", () => {
  it("two tabs racing expectedVersion 0 resolve to one winner at version 1 and one clean 409", async () => {
    const { withUser } = createFakeWorkflowGraphsClient();
    const scope = { ownerId: "user-1" };
    const graphA: GraphDocType = {
      nodes: [{ id: "a", type: "source", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const graphB: GraphDocType = {
      nodes: [{ id: "b", type: "destination", position: { x: 1, y: 1 }, config: {} }],
      edges: [],
    };

    const results = await Promise.allSettled([
      putWorkflowGraph(withUser, scope, "wf-1", { graph: graphA, expectedVersion: 0 }),
      putWorkflowGraph(withUser, scope, "wf-1", { graph: graphB, expectedVersion: 0 }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof putWorkflowGraph>>> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value.version).toBe(1);

    const rejection = rejected[0]!.reason;
    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(409);
    expect((rejection as AppError).code).toBe("VERSION_CONFLICT");
  });
});

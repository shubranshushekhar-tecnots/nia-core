import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GraphDoc as GraphDocType } from "@nia/schemas";
import { AppError } from "../lib/appError.js";
import { putWorkflowGraph } from "./workflowGraphs.js";

/**
 * Hand-rolled fake standing in for the exact subset of the SupabaseClient
 * chain putWorkflowGraph issues, backed by a single in-memory row that
 * mimics workflow_graphs' real constraints from 0012_workflow_graphs.sql:
 * `INSERT ... ON CONFLICT (workflow_id) DO NOTHING` for the upsert path,
 * and a conditional `UPDATE ... WHERE version = :expected` for the update
 * path. Each "query" resolves its winner/loser decision synchronously at
 * the point its terminal call (.maybeSingle()) is invoked, mirroring how
 * a real query resolves eagerly once issued — so racing two
 * putWorkflowGraph() calls via Promise.allSettled deterministically
 * reproduces the two-tab first-save race called out on review, without a
 * live Postgres instance.
 */
function createFakeWorkflowGraphsClient(): SupabaseClient {
  let row: { workflow_id: string; graph: unknown; version: number } | null = null;

  const client = {
    from(table: string) {
      if (table === "workflows") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                eq: () => Promise.resolve({ count: 1 }),
              }),
            }),
          }),
        };
      }

      if (table === "workflow_graphs") {
        return {
          upsert: (input: { workflow_id: string; graph: unknown }) => ({
            select: () => ({
              maybeSingle: async () => {
                if (row) return { data: null, error: null }; // ON CONFLICT (workflow_id) DO NOTHING
                row = { workflow_id: input.workflow_id, graph: input.graph, version: 1 };
                return { data: { graph: row.graph, version: row.version }, error: null };
              },
            }),
          }),
          update: (patch: { graph: unknown }) => ({
            eq: (_col1: string, _workflowId: string) => ({
              eq: (_col2: string, expectedVersion: number) => ({
                select: () => ({
                  maybeSingle: async () => {
                    if (!row || row.version !== expectedVersion) return { data: null, error: null };
                    row = { ...row, graph: patch.graph, version: row.version + 1 };
                    return { data: { graph: row.graph, version: row.version }, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }

      if (table === "clean_plans") {
        // Not exercised by this race test — an empty result lets
        // putWorkflowGraph's unbindStaleCleanPlans no-op.
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }

      throw new Error(`unexpected table "${table}" in fake`);
    },
  };

  return client as unknown as SupabaseClient;
}

describe("putWorkflowGraph — first-save race", () => {
  it("two tabs racing expectedVersion 0 resolve to one winner at version 1 and one clean 409", async () => {
    const supabase = createFakeWorkflowGraphsClient();
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
      putWorkflowGraph(supabase, scope, "wf-1", { graph: graphA, expectedVersion: 0 }),
      putWorkflowGraph(supabase, scope, "wf-1", { graph: graphB, expectedVersion: 0 }),
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

import { GraphDoc, parseNodeConfig, type GraphDoc as GraphDocType } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { computeStepsHash } from "../lib/cleanStepsHash.js";
import { assertWorkflowInScope } from "./checks.js";

export type WorkflowGraphResult = { graph: GraphDocType; version: number };

/**
 * Phase 13 Step 6, third bullet — a manual edit to a CleanPlan-bound
 * transform node's steps removes the binding. Called after every
 * successful graph write (both branches of putWorkflowGraph below), so it
 * also covers a Copilot-applied diff that isn't going through
 * applyCleaningPlanDiff's own upsert (e.g. a revert), and a node/edge
 * deletion that removes a bound node entirely. Deliberately keyed off the
 * just-written graph, not a re-fetch — putWorkflowGraph's caller already
 * has the authoritative post-write doc.
 *
 * Best-effort: a failure here must never fail the graph save itself (the
 * save already committed) — worst case a stale binding survives until the
 * next save or until runEtl.ts's drift check (cleanPlanDrift.ts) catches
 * it by hash/schema/profile mismatch some other way. Logged, not thrown.
 */
async function unbindStaleCleanPlans(withUser: WithUser, workflowId: string, graph: GraphDocType): Promise<void> {
  let bindings: { node_id: string; steps_hash: string }[];
  try {
    const { rows } = await withUser((db) =>
      db.query<{ node_id: string; steps_hash: string }>(`select node_id, steps_hash from clean_plans where workflow_id = $1`, [
        workflowId,
      ]),
    );
    bindings = rows;
  } catch {
    return;
  }
  if (bindings.length === 0) return;

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const staleNodeIds: string[] = [];
  for (const binding of bindings) {
    const node = nodesById.get(binding.node_id);
    if (!node || node.type !== "transform") {
      staleNodeIds.push(binding.node_id);
      continue;
    }
    const parsed = parseNodeConfig("transform", node.config);
    if (parsed.unrecognized || parsed.type !== "transform" || computeStepsHash(parsed.value.steps) !== binding.steps_hash) {
      staleNodeIds.push(binding.node_id);
    }
  }
  if (staleNodeIds.length === 0) return;

  try {
    await withUser((db) =>
      db.query(`delete from clean_plans where workflow_id = $1 and node_id = any($2::text[])`, [workflowId, staleNodeIds]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`unbindStaleCleanPlans: failed to delete stale clean_plans rows for workflow ${workflowId}:`, message);
  }
}

/**
 * Version 0 is the "never saved" sentinel (documented on GraphDoc and on
 * the GET route below): a workflow that has no workflow_graphs row yet
 * reads back as this default doc at version 0, not a 404, so the canvas
 * can treat "brand new workflow" and "existing empty graph" (version >= 1)
 * as distinct UI states if it ever needs to.
 */
const EMPTY_GRAPH: GraphDocType = { nodes: [], edges: [] };

export async function getWorkflowGraph(withUser: WithUser, scope: WorkspaceScope, workflowId: string): Promise<WorkflowGraphResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const { rows } = await withUser((db) =>
    db.query<{ graph: unknown; version: number }>(`select graph, version from workflow_graphs where workflow_id = $1`, [workflowId]),
  );
  const data = rows[0];
  if (!data) return { graph: EMPTY_GRAPH, version: 0 };
  return { graph: GraphDoc.parse(data.graph), version: data.version };
}

/**
 * expectedVersion 0 means "the client believes this workflow has never
 * been saved" (per getWorkflowGraph's sentinel above). Two tabs can race
 * to be the first save: both read {version: 0}, both PUT with
 * expectedVersion 0. `upsert(..., { ignoreDuplicates: true })` compiles to
 * `INSERT ... ON CONFLICT (workflow_id) DO NOTHING`, so exactly one of
 * them creates the row; the loser sees an empty result (not an error) and
 * falls through to the same conditional UPDATE every later save uses —
 * which now matches zero rows (the winner's row is already at version 1,
 * not 0) and produces the same 409 as any other conflict. Net: the first
 * save race resolves to one winner + one ordinary 409, no special case
 * for the caller.
 */
export async function putWorkflowGraph(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  input: { graph: GraphDocType; expectedVersion: number },
): Promise<WorkflowGraphResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  if (input.expectedVersion === 0) {
    let inserted: { graph: unknown; version: number } | undefined;
    try {
      const { rows } = await withUser((db) =>
        db.query<{ graph: unknown; version: number }>(
          `insert into workflow_graphs (workflow_id, graph) values ($1, $2)
           on conflict (workflow_id) do nothing
           returning graph, version`,
          [workflowId, input.graph],
        ),
      );
      inserted = rows[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(500, "GRAPH_WRITE_FAILED", message);
    }
    if (inserted) {
      const parsedGraph = GraphDoc.parse(inserted.graph);
      await unbindStaleCleanPlans(withUser, workflowId, parsedGraph);
      return { graph: parsedGraph, version: inserted.version };
    }
    // Conflict — someone else's INSERT won. Fall through to the standard
    // conditional UPDATE below; it will affect 0 rows and produce a 409.
  }

  // The version this UPDATE sets is discarded by workflow_graphs_bump_version
  // whenever graph actually changes (0012_workflow_graphs.sql) — that
  // trigger is what guarantees the increment, not this statement. This
  // WHERE clause is the 409 decision: 0 rows affected means another
  // session's save already moved the row past expectedVersion.
  let data: { graph: unknown; version: number } | undefined;
  try {
    const { rows } = await withUser((db) =>
      db.query<{ graph: unknown; version: number }>(
        `update workflow_graphs set graph = $1 where workflow_id = $2 and version = $3 returning graph, version`,
        [input.graph, workflowId, input.expectedVersion],
      ),
    );
    data = rows[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "GRAPH_WRITE_FAILED", message);
  }

  if (!data) throw new AppError(409, "VERSION_CONFLICT", "This workflow was saved by another session. Reload and retry.");

  const parsedGraph = GraphDoc.parse(data.graph);
  await unbindStaleCleanPlans(withUser, workflowId, parsedGraph);
  return { graph: parsedGraph, version: data.version };
}

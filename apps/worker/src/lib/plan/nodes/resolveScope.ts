import { withServiceRole } from "@nia/db";
import { dbPool } from "../../dbPool.js";
import { resolveGraph } from "../../checks/runWorkflowChecks.js";
import { listVisibleConnections } from "../listConnections.js";
import type { PlanStateType } from "../state.js";

/**
 * Fetches the three pieces of read context every downstream plan node
 * needs: the workflow's current GraphDoc (resolveGraph — the same
 * WorkspaceScope-filtered, service_role-safe fetch runWorkflowChecks.ts
 * already exports and uses), that graph's workflow_graphs.version (Session
 * 2's staleness-check anchor — stamped onto the returned Plan by
 * runPlanPropose.ts, see plan.ts's baseGraphVersion doc comment), and the
 * caller's full list of visible connections (listConnections.ts) — both the
 * LLM's candidate context (generatePlanNode) and checkConnectionsNode's
 * closed-world check draw from this same fetch.
 *
 * The version read here is a plain, unscoped select (no separate
 * workspace-in-scope check) because resolveGraph just above it already
 * proved workflowId is in `state.scope` — a second scope check on the same
 * row would be redundant, not defense-in-depth. Absent row (never-saved
 * workflow) reads back as version 0, matching putWorkflowGraph's own
 * "version 0 == never saved" sentinel (apps/api/src/services/workflowGraphs.ts).
 */
export async function resolveScopeNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const graph = await resolveGraph(state.workflowId, state.scope);
  if (!graph) {
    return { error: `Workflow ${state.workflowId} not found in the given workspace.` };
  }
  const graphResult = await withServiceRole(dbPool, (db) =>
    db.query<{ version: number }>("select version from public.workflow_graphs where workflow_id = $1", [state.workflowId]),
  );
  const connections = await listVisibleConnections(state.scope);
  return { existingGraph: graph, graphVersion: graphResult.rows[0]?.version ?? 0, connections };
}

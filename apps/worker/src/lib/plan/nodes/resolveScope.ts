import { resolveGraph } from "../../checks/runWorkflowChecks.js";
import { listVisibleConnections } from "../listConnections.js";
import type { PlanStateType } from "../state.js";

/**
 * Fetches the two pieces of read context every downstream plan node needs:
 * the workflow's current GraphDoc (resolveGraph — the same WorkspaceScope-
 * filtered, service_role-safe fetch runWorkflowChecks.ts already exports and
 * uses) and the caller's full list of visible connections (listConnections.ts)
 * — both the LLM's candidate context (generatePlanNode) and
 * checkConnectionsNode's closed-world check draw from this same fetch.
 */
export async function resolveScopeNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const graph = await resolveGraph(state.workflowId, state.scope);
  if (!graph) {
    return { error: `Workflow ${state.workflowId} not found in the given workspace.` };
  }
  const connections = await listVisibleConnections(state.scope);
  return { existingGraph: graph, connections };
}

import type { PlanStateType } from "../state.js";

/**
 * Closed-world check: every PlanNode.connectionId referenced by the
 * generated plan must be present in state.connections (the
 * WorkspaceScope-filtered list resolveScopeNode already fetched) — never
 * trust a model-emitted connectionId just because it looks like a UUID.
 * Distinct from a validatePlanStructure/validatePlanFeasibility failure so
 * the golden suite/caller can tell "invisible connection" apart from
 * "well-formed-but-infeasible plan" (mirrors chat's own separate
 * no-connection-selected outcome).
 */
export async function checkConnectionsNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const visibleIds = new Set(state.connections.map((c) => c.id));
  const invisible = state.plan!.nodes.some((n) => n.connectionId && !visibleIds.has(n.connectionId));
  return { noConnection: invisible };
}

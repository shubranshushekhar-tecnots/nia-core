import type { PlanStateType } from "../state.js";

/**
 * Terminal no-op — Session 1 has no streaming/publish infra for the plan
 * pipeline yet (that's Session 3's SSE work, per the approved plan's
 * Session 3 section). runPlanPropose.ts reads the final PlanStateType
 * directly (error/refusalKind/lastValidationOutcome/noConnection/
 * clarifyQuestion) to build its PlanProposeResult; this node exists only so
 * the graph has an explicit terminal fail vertex every failure branch
 * routes to, mirroring chat/graph.ts's shape.
 */
export async function failNode(_state: PlanStateType): Promise<Partial<PlanStateType>> {
  return {};
}

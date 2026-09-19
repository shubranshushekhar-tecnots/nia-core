import type { PlanStateType } from "../state.js";

/** Shared by every conditional edge in graph.ts — every plan-state shape carries `error?: string`. */
export function hasError(state: { error?: string }): boolean {
  return state.error !== undefined;
}

/**
 * Shared by validateStructureNode/validateFeasibilityNode — caps the
 * structure/feasibility retry loop at exactly one retry. planGenAttempts is
 * incremented once per generatePlanNode call (including the very first), so
 * the first validation failure (attempts=1) retries, and a second failure
 * (attempts=2) refuses — same cap-1-attempt shape as chat's queryGenAttempts
 * (chat/state.ts's header comment).
 */
export function decideRetryOrRefuse(
  state: PlanStateType,
  message: string,
  kind: "unsupported-operation" | "partial-failure" | "capacity-limit",
): Partial<PlanStateType> {
  if (state.planGenAttempts < 2) {
    return { lastValidationOutcome: "retry", feedback: message };
  }
  return { lastValidationOutcome: "refused", refusalKind: kind, error: message };
}

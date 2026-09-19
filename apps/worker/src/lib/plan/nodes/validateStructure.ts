import { validatePlanStructure } from "@nia/schemas";
import type { PlanStateType } from "../state.js";
import { decideRetryOrRefuse } from "./shared.js";

/** Pure structural check (plan.ts's validatePlanStructure) — bad config, dangling edge ref, id collision, or a cycle. */
export async function validateStructureNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const failures = validatePlanStructure(state.plan!, state.existingGraph!).filter((r) => r.status === "fail");
  if (failures.length === 0) return { lastValidationOutcome: "ok" };

  const message = failures.map((f) => f.message).join(" ");
  // Structural failures are always "unsupported-operation" in refusal-kind
  // vocabulary — never "capacity-limit" (feasibility-only) and never
  // "partial-failure" (this pipeline emits a whole plan or nothing, no
  // partial application).
  return decideRetryOrRefuse(state, message, "unsupported-operation");
}

import type { Plan, PlanProposeJob } from "@nia/schemas";
import { buildPlanGraph } from "./graph.js";
import type { PlanStateType } from "./state.js";

export type PlanProposeResult =
  | { status: "error"; error: string }
  | { status: "no-connection"; message: string }
  | { status: "refused"; kind: "unsupported-operation" | "partial-failure" | "capacity-limit"; message: string }
  | { status: "clarify"; question: string }
  | { status: "ok"; plan: Plan; planGenAttempts: number };

const graph = buildPlanGraph();

/**
 * Entry point — the exact code path both the plan_propose job handler
 * (index.ts) and the golden suite runner call, mirroring chat's
 * runChatQuery.ts. Checks are ordered most-specific-first since more than
 * one final-state field can be set at once (e.g. a "refused" outcome also
 * carries `error`, so that check must run before the generic error check).
 */
export async function runPlanPropose(job: PlanProposeJob, jobId: string): Promise<PlanProposeResult> {
  const initialState: Partial<PlanStateType> = {
    jobId,
    userId: job.userId,
    workflowId: job.workflowId,
    conversationId: job.conversationId,
    scope: job.scope,
    rawMessage: job.message,
  };

  const finalState = (await graph.invoke(initialState)) as PlanStateType;

  if (finalState.lastValidationOutcome === "refused") {
    return { status: "refused", kind: finalState.refusalKind!, message: finalState.error ?? "Plan refused." };
  }
  if (finalState.noConnection) {
    return { status: "no-connection", message: "The plan references a connection that isn't visible in this workspace." };
  }
  if (finalState.error !== undefined) {
    return { status: "error", error: finalState.error };
  }
  if (finalState.clarifyQuestion !== undefined) {
    return { status: "clarify", question: finalState.clarifyQuestion };
  }
  // baseGraphVersion is always server-stamped here, overwriting whatever
  // the LLM's Plan JSON happened to default to (the prompt never mentions
  // this field) — never trust an LLM-emitted value for Session 2's
  // staleness check, same precedent checkConnections' closed-world check
  // sets for connectionId. See plan.ts's baseGraphVersion doc comment.
  return {
    status: "ok",
    plan: { ...finalState.plan!, baseGraphVersion: finalState.graphVersion },
    planGenAttempts: finalState.planGenAttempts,
  };
}

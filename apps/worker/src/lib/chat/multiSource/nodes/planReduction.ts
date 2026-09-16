import type { MultiSourceStateType } from "../state.js";
import { completeJson, JsonExtractionError } from "../../../llm/parseHelpers.js";
import { buildReductionPlanPrompt, validateReductionPlanShape, type ReductionPlan } from "../../../llm/prompts/reductionPlan.js";
import { publishChatEvent } from "../../publish.js";

/**
 * Runs BEFORE any per-source resolve/query-gen/dispatch — a structured
 * output decided up front, never inferred after the fact from generated
 * SQL/Mongo text (see reductionPlan.ts's header). An unsupported question
 * is refused here, before any connection is even resolved, let alone
 * queried.
 *
 * Classified from the question TEXT ALONE, with no schema — this matches
 * the feature's own constraint ("no field mapping"): a `targetField` like
 * "salary" is assumed to name the same field consistently across every
 * source. Each source's own query-gen step (generateQuery.ts) still
 * validates that field actually exists against that source's own real
 * schema independently, and fails that one source's pipeline (not the
 * whole plan) if it doesn't.
 */
export async function planReductionNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "planning_reduction" });

  let plan: ReductionPlan;
  try {
    // Deliberately NOT on QUERYGEN_MODEL: every fast flash tier tested
    // (2.5-flash, 3.5-flash) regressed this call's count/sum/conflict
    // classification intermittently (flaky 16-19/20 on the golden set
    // across runs) even though generateQuery.ts's structurally similar
    // JSON-output call stayed clean on the same tiers. Stays on the
    // default model. See PHASE4_EXIT.md §4 Fix 1.
    const parsed = await completeJson(buildReductionPlanPrompt({ question: state.standaloneMessage }), {
      node: "planReduction",
    });
    plan = validateReductionPlanShape(parsed);
  } catch (err) {
    if (!(err instanceof JsonExtractionError)) throw err;
    plan = { supported: false, reason: `Reduction planning returned unparseable output: ${err.message}` };
  }

  if (!plan.supported) {
    return { reductionPlan: plan, refusal: { kind: "unsupported-operation", message: plan.reason } };
  }
  return { reductionPlan: plan };
}

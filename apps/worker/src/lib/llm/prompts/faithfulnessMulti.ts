import type { ChatMessage } from "../gatewayClient.js";
import type { ReduceOutcome } from "../../chat/multiSource/reduce.js";
import type { ReductionPlan } from "./reductionPlan.js";
import { formatOutcome } from "./answerGenMulti.js";

/**
 * Multi-source faithfulness check — grades an answer against the
 * already-computed ReduceOutcome, not raw rows. Same faithfulness-is-
 * blind-to-arithmetic caveat applies as in the single-source check (see
 * reduce.ts's header): this can only catch the model stating a DIFFERENT
 * number or fact than the one it was given, never a wrong reduction — that
 * class of error is structurally prevented earlier, by reduce.ts being the
 * only place the arithmetic happens at all.
 */
export function buildFaithfulnessMultiPrompt(args: {
  question: string;
  answer: string;
  plan: Extract<ReductionPlan, { supported: true }>;
  outcome: Extract<ReduceOutcome, { ok: true }>;
}): ChatMessage[] {
  const system = `You grade whether an answer is fully and only supported by a single already-computed result. Respond with EXACTLY one line:
"OK" if the answer states this exact value for ${args.plan.targetDescription}, without fabricating any other numeric claim.
"CONFLICT: <short reason>" if the answer states, implies, or fabricates any different or additional numeric claim.`;

  const user = `Question: ${args.question}\n\n${formatOutcome(args.outcome)}\n\nAnswer to grade: ${args.answer}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

import type { MultiSourceStateType } from "../state.js";
import { complete } from "../../../llm/gatewayClient.js";
import { buildFaithfulnessMultiPrompt } from "../../../llm/prompts/faithfulnessMulti.js";
import { parseFaithfulnessVerdict, applyFaithfulnessVerdict } from "../../../llm/prompts/faithfulness.js";
import { publishChatEvent } from "../../publish.js";

/**
 * Grading against the computed ReduceOutcome instead of raw rows (see
 * faithfulnessMulti.ts's header for why that's still meaningful despite
 * reduce.ts's arithmetic-blindness caveat) — retry/ship decision is the
 * same shared applyFaithfulnessVerdict policy ../../nodes/faithfulness.ts uses.
 */
export async function faithfulnessMultiNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "checking_faithfulness" });

  const plan = state.reductionPlan;
  const outcome = state.reduceOutcome;
  if (!plan?.supported || !outcome?.ok) {
    return { error: "faithfulnessMultiNode reached without a supported plan and successful reduce outcome." };
  }

  const messages = buildFaithfulnessMultiPrompt({
    question: state.standaloneMessage,
    answer: state.answer!,
    plan,
    outcome,
  });
  const raw = await complete(messages, { node: "faithfulnessMulti" });
  const verdict = parseFaithfulnessVerdict(raw);
  return applyFaithfulnessVerdict(verdict, state.answerGenAttempts);
}

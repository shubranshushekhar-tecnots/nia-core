import type { ChatStateType } from "../state.js";
import { complete } from "../../llm/gatewayClient.js";
import { buildFaithfulnessPrompt, parseFaithfulnessVerdict, applyFaithfulnessVerdict } from "../../llm/prompts/faithfulness.js";
import { publishChatEvent } from "../publish.js";

/**
 * Grades the answer against the data it was generated from. Retry/ship
 * decision is applyFaithfulnessVerdict's shared policy (see its header) —
 * never loops more than once (graph.ts caps this via answerGenAttempts).
 */
export async function faithfulnessNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "checking_faithfulness" });
  const messages = buildFaithfulnessPrompt({
    question: state.standaloneMessage,
    answer: state.answer!,
    result: state.tabularResult!,
  });
  const raw = await complete(messages, { node: "faithfulness" });
  const verdict = parseFaithfulnessVerdict(raw);
  return applyFaithfulnessVerdict(verdict, state.answerGenAttempts);
}

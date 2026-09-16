import type { MultiSourceStateType } from "../state.js";
import { streamComplete } from "../../../llm/gatewayClient.js";
import { buildAnswerGenMultiPrompt } from "../../../llm/prompts/answerGenMulti.js";
import { publishChatEvent } from "../../publish.js";
import { env } from "../../../../env.js";

/**
 * Only ever reached with a single, unambiguous ReduceOutcome — a tie routes
 * to conflictNode.ts instead (see verifyAndReduceNode.ts), so there is
 * nothing here to disambiguate. Mirrors buildAnswer.ts's structure but
 * grounds the model in the already-computed outcome, never raw per-source
 * rows (see answerGenMulti.ts's header).
 */
export async function buildAnswerMultiNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  await publishChatEvent(state.scope, state.jobId,{ type: "status", stage: "generating_answer" });

  const plan = state.reductionPlan;
  const outcome = state.reduceOutcome;
  if (!plan?.supported || !outcome?.ok) {
    // Unreachable in practice — the graph only routes here once both are
    // set to their "ok" variants — but typed defensively rather than `!`.
    return { error: "buildAnswerMultiNode reached without a supported plan and successful reduce outcome." };
  }

  const messages = buildAnswerGenMultiPrompt({
    question: state.standaloneMessage,
    plan,
    outcome,
    rejectionReason: state.faithfulnessReason,
    previousAnswer: state.answer,
  });

  const answer = await streamComplete(
    messages,
    (delta) => publishChatEvent(state.scope, state.jobId,{ type: "token", text: delta }),
    { node: "buildAnswerMulti", model: env.ANSWER_MODEL },
  );

  // Clear the prior faithfulness reason once it's been fed into this
  // attempt — a fresh one is set only if the next check conflicts again.
  return { answer, faithfulnessReason: undefined };
}

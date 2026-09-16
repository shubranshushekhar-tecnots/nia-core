import type { ChatStateType } from "../state.js";
import { streamComplete } from "../../llm/gatewayClient.js";
import { buildAnswerGenPrompt } from "../../llm/prompts/answerGen.js";
import { publishChatEvent } from "../publish.js";
import { env } from "../../../env.js";

/**
 * Truncation handling is structural, not prompt-hoped: when
 * tabularResult.meta.truncated is true, this caveat is prepended in code
 * — streamed to the client BEFORE any model token — regardless of whether
 * the model's own text mentions truncation. The prompt also carries an
 * instruction (belt and braces), but the client-visible guarantee comes
 * from here, not from what the model chooses to write.
 */
function truncationCaveat(rowCount: number): string {
  return `⚠️ Results were truncated to ${rowCount} row(s) — this answer is based on a partial sample, not the complete result set.\n\n`;
}

export async function buildAnswerNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "generating_answer" });
  const result = state.tabularResult!;

  let answer = "";
  if (result.meta.truncated) {
    const caveat = truncationCaveat(result.rows.length);
    answer += caveat;
    await publishChatEvent(state.scope, state.jobId, { type: "token", text: caveat });
  }

  const messages = buildAnswerGenPrompt({
    question: state.standaloneMessage,
    result,
    rejectionReason: state.faithfulnessReason,
    previousAnswer: state.answer,
  });

  const modelText = await streamComplete(
    messages,
    (delta) => publishChatEvent(state.scope, state.jobId, { type: "token", text: delta }),
    { node: "buildAnswer", model: env.ANSWER_MODEL },
  );
  answer += modelText;

  // Clear the prior faithfulness reason once it's been fed into this
  // attempt — a fresh one is set only if the next check conflicts again.
  return { answer, faithfulnessReason: undefined };
}

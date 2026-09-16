import type { MultiSourceStateType } from "../state.js";
import { publishChatEvent } from "../../publish.js";

/**
 * Terminal tie path — a max/min reduction with more than one winner (see
 * verifyAndReduceNode.ts). Publishes the deterministic, code-formatted
 * `conflict` event and stops: no answer is generated, no faithfulness
 * check runs, no `done` follows — this is its own outcome, not folded into
 * `done.faithful`.
 */
export async function conflictNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  await publishChatEvent(state.scope, state.jobId, {
    type: "conflict",
    message: state.conflictMessage ?? "Multiple sources tied for the requested result.",
  });
  return {};
}

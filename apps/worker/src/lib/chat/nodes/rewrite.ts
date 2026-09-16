import type { ChatStateType } from "../state.js";
import { publishChatEvent } from "../publish.js";

/**
 * Rewrite is a pass-through today: ChatQueryJob carries no conversation
 * history, only the current message, so there is nothing to resolve
 * pronouns/references against yet. Kept as its own graph node (rather than
 * skipped entirely) so wiring in real history later is a change to this
 * one node, not a graph restructure. Deliberate scoping decision — see
 * Phase 2 discussion.
 */
export async function rewriteNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "rewriting" });
  return { standaloneMessage: state.rawMessage };
}

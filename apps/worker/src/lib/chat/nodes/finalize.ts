import type { ChatStateType } from "../state.js";
import { publishChatEvent } from "../publish.js";

/**
 * Terminal success path. Publishes the citation (carrying the exact
 * executed query + truncated flag, structurally — not dependent on the
 * model mentioning it) and a `done` event whose `faithful` flag surfaces
 * an unresolved faithfulness conflict to the client rather than shipping
 * it silently.
 */
export async function finalizeNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  const result = state.tabularResult!;
  await publishChatEvent(state.scope, state.jobId, {
    type: "citation",
    connectionId: result.meta.connectionId,
    executedQuery: result.meta.executedQuery,
    rowCount: result.meta.rowCount,
    truncated: result.meta.truncated,
  });
  await publishChatEvent(state.scope, state.jobId, { type: "done", faithful: state.faithful });
  return {};
}

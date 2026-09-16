import type { MultiSourceStateType } from "../state.js";
import { publishChatEvent } from "../../publish.js";

/**
 * Terminal success path. Publishes one citation per contributing source
 * (fanOutSources.ts already refused on any per-source failure, so every
 * entry in state.sourceResults here is ok with a tabularResult), then a
 * single `done` event.
 *
 * `truncated` on `done` reflects whether ANY contributing source was
 * truncated — structurally, that will always be `false` here in practice,
 * because reduce.ts refuses (rather than computing from) any truncated
 * source, for both max/min and sum/count (see reduce.ts's header). The
 * field is kept anyway for shape-parity with the single-source `done`
 * event and so this invariant isn't silently assumed by the client too.
 */
export async function finalizeMultiNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  let truncated = false;
  for (const source of state.sourceResults) {
    if (!source.ok || !source.tabularResult) continue;
    truncated = truncated || source.tabularResult.meta.truncated;
    await publishChatEvent(state.scope, state.jobId, {
      type: "citation",
      connectionId: source.connectionId,
      executedQuery: source.tabularResult.meta.executedQuery,
      rowCount: source.tabularResult.meta.rowCount,
      truncated: source.tabularResult.meta.truncated,
    });
  }
  await publishChatEvent(state.scope, state.jobId, { type: "done", faithful: state.faithful, truncated });
  return {};
}

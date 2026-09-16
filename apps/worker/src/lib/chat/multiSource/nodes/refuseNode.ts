import type { MultiSourceStateType } from "../state.js";
import { publishChatEvent } from "../../publish.js";

/**
 * Terminal refusal path — publishes `state.refusal` verbatim (kind +
 * message already set by whichever node detected it: planReduction for
 * unsupported-operation, fanOutSources/verifyAndReduce for partial-failure,
 * index.ts's job-handler branching for capacity-limit before the graph is
 * even invoked). No `done` follows, mirroring failNode.
 */
export async function refuseNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  const refusal = state.refusal ?? { kind: "partial-failure" as const, message: "Request was refused for an unknown reason." };
  await publishChatEvent(state.scope, state.jobId, { type: "refused", kind: refusal.kind, message: refusal.message });
  return {};
}

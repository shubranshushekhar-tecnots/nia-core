import { resolveConnection } from "../../resolveConnection.js";
import { publishChatEvent } from "../publish.js";
import type { ResolveConnectionState } from "./shared.js";

/** Widened to ResolveConnectionState (see shared.ts) so this same function is reused unchanged by the multi-source per-source subgraph. */
export async function resolveConnectionNode(state: ResolveConnectionState): Promise<Partial<ResolveConnectionState>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "resolving" });
  const result = await resolveConnection(state.connectionId, state.scope);
  if (!result.ok) return { error: result.error.message };
  return { connection: result.value };
}

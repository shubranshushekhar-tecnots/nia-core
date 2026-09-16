import { getSchema } from "../../introspection.js";
import { publishChatEvent } from "../publish.js";
import type { GetSchemaState } from "./shared.js";

/** Widened to GetSchemaState (see shared.ts) so this same function is reused unchanged by the multi-source per-source subgraph. */
export async function getSchemaNode(state: GetSchemaState): Promise<Partial<GetSchemaState>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "introspecting" });
  // resolveConnectionNode always runs first and sets `error` on failure,
  // short-circuiting before this node is reached — see graph.ts's edges.
  const connection = state.connection!;
  const result = await getSchema(connection);
  if (!result.ok) return { error: result.error.message };
  return { schema: result.value };
}

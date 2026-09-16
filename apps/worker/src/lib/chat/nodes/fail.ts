import { buildFailNode } from "./shared.js";

/** Terminal failure path — publishes a single clear error event, no retries left. Widened via buildFailNode (see shared.ts) so multiSource/nodes/failNode.ts is the same function, just a different fallback message. */
export const failNode = buildFailNode("Chat pipeline failed for an unknown reason.");

import { buildFailNode } from "../../nodes/shared.js";

/** Terminal failure path — see ../../nodes/fail.ts and shared.ts's buildFailNode. Only reachable via the defensive `error` checks in graph.ts; every expected failure mode routes through `refusal`/refuseNode.ts instead. */
export const failNode = buildFailNode("Multi-source chat pipeline failed for an unknown reason.");

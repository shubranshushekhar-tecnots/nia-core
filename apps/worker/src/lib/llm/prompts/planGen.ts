import type { GraphDoc, IntrospectResponse } from "@nia/schemas";
import type { ChatMessage } from "../gatewayClient.js";
import type { VisibleConnection } from "../../plan/listConnections.js";

/**
 * Copilot plan-generation prompt (Phase 7 Session 1). Kept in its own file
 * per this codebase's per-call-site prompt convention (llm/prompts/queryGen.*)
 * even though there's exactly one variant so far — the model must choose
 * real entities from the schema context given, never invent table/column
 * names, same "only reference what's in the schema" rule queryGen.*.ts
 * already enforce.
 */
export function buildPlanGenPrompt(args: {
  message: string;
  existingGraph: GraphDoc;
  connections: VisibleConnection[];
  schemasByConnectionId: Map<string, IntrospectResponse>;
  feedback?: string;
}): ChatMessage[] {
  const system = `You propose an ADD-ONLY mutation to a data-workflow graph, based on a user's natural-language request.

Output ONLY compact JSON, no prose, no markdown fences, matching exactly one of these two shapes:
  {"clarifyQuestion": "<question>", "plan": null}
  {"clarifyQuestion": null, "plan": {"summary": "<one line>", "nodes": [...], "edges": [...]}}

Use the clarifyQuestion shape when the request is ambiguous (doesn't name a specific connection/table and more than one candidate exists, or the requested operation is unclear) — ask, never guess.

Use the plan shape otherwise. Plan node shape:
  {"id": "new-1", "type": "source"|"transform"|"destination", "connectionId": "<uuid>", "config": {...}, "position": {"x": 0, "y": 0}}
- connectionId: required for source/destination nodes. OMIT this key entirely for transform nodes (they have no connection) — never set it to null.
- source/destination config: {"operation": "read", "entity": {"namespace": "...", "name": "..."}}. Only reference an entity actually listed in that connection's schema below. Never invent namespace/name.
- transform config: {"steps": [{"kind": "filter", "conditions": [{"field": "...", "operator": "eq", "value": "..."}]}, {"kind": "aggregate", "groupBy": ["..."], "aggregations": [{"fn": "count", "field": null, "alias": "..."}]}]}. Only these two step kinds are supported right now.
Plan edge shape: {"id": "e1", "source": "<a plan node id or an existing graph node id below>", "target": "<same>"}.

Rules:
- Node ids must be unique and must NOT reuse any id from the existing graph below.
- Only use connectionId values from the candidate connections list below — never invent one.
- This is strictly additive: never propose deleting or modifying an existing node or edge.
- Space out new node positions (e.g. x += 240 per stage) so they don't overlap each other or the existing graph.`;

  const existingNodesDesc = args.existingGraph.nodes.length
    ? args.existingGraph.nodes.map((n) => `- ${n.id} (${n.type}${n.connectionId ? `, connection ${n.connectionId}` : ""})`).join("\n")
    : "(empty — no nodes yet)";

  const connectionsDesc = args.connections.length
    ? args.connections
        .map((c) => {
          const schema = args.schemasByConnectionId.get(c.id);
          const entities = schema
            ? schema.entities.map((e) => `${e.namespace}.${e.name} (${e.fields.map((f) => f.name).join(", ")})`).join("; ")
            : "(schema unavailable)";
          return `- ${c.id} — "${c.handle}" (${c.connectorId}): ${entities}`;
        })
        .join("\n")
    : "(no connections visible in this workspace)";

  const correction = args.feedback
    ? `\n\nYour previous plan was rejected: "${args.feedback}". Propose a different, valid plan that avoids this problem.`
    : "";

  const user = `Existing graph nodes:\n${existingNodesDesc}\n\nCandidate connections:\n${connectionsDesc}\n\nUser request: ${args.message}${correction}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

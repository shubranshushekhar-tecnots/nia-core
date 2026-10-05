import type { GraphDoc, GraphNode } from "./graph.js";
import { SourceDestConfig, TransformConfig, exprToConditions, type FilterCondition } from "./nodeConfig.js";
import { AgentJobSetup } from "./agentJobSetup.js";

/**
 * Agent-Canvas integration, Slice R4 (docs/plans/agent-canvas-integration.md
 * B.7, item 5) — the one function that turns a saved GraphDoc into the R3a
 * `AgentJobSetup` a job is published with, or a list of plain-language
 * problems when it cannot. Pure, no I/O (same discipline as checks.ts):
 * everything it needs — the source's selected table/columns/params, the
 * destination's mapping and Delivery section, the filter between them — is
 * already persisted on the graph's own nodes by the canvas UI.
 *
 * A workflow is "agent-delivered" exactly when its graph has a source node
 * on connector "sqlserver-agent" reachable (via transform nodes carrying
 * nothing but an allowed filter step) to a destination node on connector
 * "planometry-table" or "https-endpoint" — same definition the task gave,
 * and the same one apps/web uses to decide whether to show Publish instead
 * of Run.
 */

const AGENT_SOURCE_MANIFEST = "sqlserver-agent";
const AGENT_DESTINATION_MANIFESTS = new Set(["planometry-table", "https-endpoint"]);

export type DeriveAgentJobSetupResult = { ok: true; setup: AgentJobSetup } | { ok: false; problems: string[] };

function nodeLabel(node: GraphNode): string {
  return node.manifestId ?? node.id;
}

/** DFS from `fromId` to `toId`, returning the node-id path (inclusive of both ends) or null if unreachable. Mirrors checks.ts's checkDag reachability walk. */
function findPath(fromId: string, toId: string, outAdj: Map<string, string[]>): string[] | null {
  const stack: string[][] = [[fromId]];
  const seen = new Set<string>([fromId]);
  while (stack.length > 0) {
    const path = stack.pop()!;
    const current = path[path.length - 1]!;
    if (current === toId) return path;
    for (const next of outAdj.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push([...path, next]);
    }
  }
  return null;
}

/** Turns a GraphDoc into a publishable AgentJobSetup, or plain-language problems. Never throws. */
export function deriveAgentJobSetupFromGraph(graph: GraphDoc): DeriveAgentJobSetupResult {
  const problems: string[] = [];

  const sourceNode = graph.nodes.find((n) => n.type === "source" && n.manifestId === AGENT_SOURCE_MANIFEST);
  if (!sourceNode) {
    return { ok: false, problems: ['This workflow needs a "Local database (via agent)" source.'] };
  }

  const destNode = graph.nodes.find((n) => n.type === "destination" && !!n.manifestId && AGENT_DESTINATION_MANIFESTS.has(n.manifestId));
  if (!destNode) {
    return { ok: false, problems: ["This workflow needs a Planometry table or HTTPS endpoint destination."] };
  }

  const outAdj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outAdj.set(edge.source, [...(outAdj.get(edge.source) ?? []), edge.target]);
  }
  const path = findPath(sourceNode.id, destNode.id, outAdj);
  if (!path) {
    return { ok: false, problems: ["The agent source and the destination are not connected."] };
  }

  const transformNodes = path
    .slice(1, -1)
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is GraphNode => !!n && n.type === "transform");

  let filterConditions: FilterCondition[] = [];
  for (const t of transformNodes) {
    const parsed = TransformConfig.safeParse(t.config);
    if (!parsed.success) {
      problems.push(`"${nodeLabel(t)}" has a configuration that doesn't match the expected shape.`);
      continue;
    }
    for (const step of parsed.data.steps) {
      if (step.kind !== "filter") {
        problems.push(
          `Only a filter step is allowed between an agent source and its destination — remove the "${step.kind}" step. Other destinations go through Nia Core.`,
        );
        continue;
      }
      const conditions = exprToConditions(step.expr);
      if (conditions === null) {
        problems.push("The filter must be a flat list of conditions joined with AND to be sent to the agent.");
        continue;
      }
      filterConditions = filterConditions.concat(conditions);
    }
  }

  const sourceConfigParsed = SourceDestConfig.safeParse(sourceNode.config);
  const destConfigParsed = SourceDestConfig.safeParse(destNode.config);
  if (!sourceConfigParsed.success) problems.push("The source node's configuration doesn't match the expected shape.");
  if (!destConfigParsed.success) problems.push("The destination node's configuration doesn't match the expected shape.");
  const sourceConfig = sourceConfigParsed.success ? sourceConfigParsed.data : undefined;
  const destConfig = destConfigParsed.success ? destConfigParsed.data : undefined;

  if (!sourceNode.connectionId) problems.push("The source node has no connection selected.");
  if (!destNode.connectionId) problems.push("The destination node has no connection selected.");
  if (sourceConfig && !sourceConfig.entity) problems.push("The source node has no table selected.");

  const delivery = destConfig?.delivery;
  if (destConfig && !delivery?.mode) problems.push("Choose a delivery mode in the destination's Delivery section.");

  const columns = sourceConfig?.columns ?? [];
  const mappingEntries = destConfig?.mapping?.entries ?? [];

  if (destNode.manifestId === "planometry-table") {
    const keyColumnNames = columns.filter((c) => c.isKey).map((c) => c.name);
    const mappedSourceFields = new Set(mappingEntries.map((e) => e.from));
    const unmappedKeys = keyColumnNames.filter((name) => !mappedSourceFields.has(name));
    if (unmappedKeys.length > 0) {
      problems.push(`Every key column must be mapped before publishing: ${unmappedKeys.join(", ")}.`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  // Every check above passed, so these are all known-defined at this point.
  const setup: unknown = {
    sourceConnectionId: sourceNode.connectionId,
    sourceTable: `${sourceConfig!.entity!.namespace}.${sourceConfig!.entity!.name}`,
    destinationConnectionId: destNode.connectionId,
    columns: columns.map((c) => ({ name: c.name, type: c.type, isKey: c.isKey })),
    mapping: mappingEntries.map((e) => ({ source: e.from, target: e.to })),
    filter: filterConditions,
    params: sourceConfig?.params ?? {},
    mode: delivery!.mode,
    watermarkColumn: delivery?.watermarkColumn,
    schedule: delivery?.schedule,
    replaceSchedule: delivery?.replaceSchedule,
    pollIntervalSeconds: delivery?.pollIntervalSeconds,
    deleteMode: delivery?.deleteMode,
    maxDeletePercent: delivery?.maxDeletePercent,
    softDeleteColumn: delivery?.softDeleteColumn,
    onNullKey: delivery?.onNullKey,
    allowEmptyReplace: delivery?.allowEmptyReplace,
  };

  const validated = AgentJobSetup.safeParse(setup);
  if (!validated.success) {
    return { ok: false, problems: validated.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, setup: validated.data };
}

import type { CanvasNode } from './mapping';

/**
 * Slice R4 (docs/plans/agent-canvas-integration.md B.7) — "A workflow is
 * agent-delivered when its source is a 'Local database (via agent)'
 * connection and its destination is a Planometry table or HTTPS endpoint
 * connection." These three manifest ids must stay in sync with
 * packages/schemas/src/agentJobSetupFromGraph.ts's own copies (kept
 * separate rather than shared/exported, since that file's constants are
 * module-private and this is browser-side gating only — the derive
 * function on the server is the actual source of truth when Publish is
 * clicked).
 */
export const AGENT_SOURCE_MANIFEST = 'sqlserver-agent';
export const AGENT_DESTINATION_MANIFESTS = new Set(['planometry-table', 'https-endpoint']);

export function isAgentSourceManifest(manifestId: string | undefined): boolean {
  return manifestId === AGENT_SOURCE_MANIFEST;
}

export function isAgentDestinationManifest(manifestId: string | undefined): boolean {
  return !!manifestId && AGENT_DESTINATION_MANIFESTS.has(manifestId);
}

/**
 * Existence check only (does a qualifying source node and a qualifying
 * destination node both appear somewhere on the canvas) — used for
 * header-level UI gating (swap Run for Publish). The precise "are they
 * actually connected, with only a filter between them" validation is
 * packages/schemas/src/agentJobSetupFromGraph.ts's job, run server-side
 * when Publish is actually clicked.
 */
export function isAgentDeliveredWorkflow(nodes: CanvasNode[]): boolean {
  const hasAgentSource = nodes.some((n) => n.data.graphNodeType === 'source' && isAgentSourceManifest(n.data.manifestId));
  const hasAgentDestination = nodes.some((n) => n.data.graphNodeType === 'destination' && isAgentDestinationManifest(n.data.manifestId));
  return hasAgentSource && hasAgentDestination;
}

import type { DeriveAgentJobSetupResult } from '@nia/schemas';
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

/**
 * Slice R4 (B.7, item 8) — deriveAgentJobSetupFromGraph (packages/schemas,
 * also the server's source of truth) doesn't check mapping approval, only
 * that key columns are mapped — so without this, Publish would stay
 * clickable while the mapping panel still says "Not approved". Pulled out
 * of FlowCanvas.tsx (which otherwise only ever mounts inside a full React
 * Flow canvas) so this decision — the actual business rule the UI has to
 * get right — can be unit-tested on its own, decoupled from needing to
 * render the whole canvas.
 */
export function computePublishGate(params: {
  readOnly: boolean;
  isAgentDelivered: boolean;
  derivedAgentSetup: DeriveAgentJobSetupResult | null;
  /** The agent-delivered destination node, if any — see isAgentDeliveredWorkflow. */
  agentDestNode: CanvasNode | undefined;
}): { publishEnabled: boolean; publishTooltip: string } {
  const { readOnly, isAgentDelivered, derivedAgentSetup, agentDestNode } = params;
  const mappingApproved =
    !agentDestNode || !!(agentDestNode.data.config as { mapping?: { approvedAt?: string | null } })?.mapping?.approvedAt;

  const publishEnabled = !readOnly && isAgentDelivered && derivedAgentSetup?.ok === true && mappingApproved;
  const publishTooltip = readOnly
    ? 'You have view-only access — ask an admin or owner for edit access to publish this workflow.'
    : derivedAgentSetup && !derivedAgentSetup.ok
      ? derivedAgentSetup.problems[0] ?? 'This workflow cannot be published as configured.'
      : !mappingApproved
        ? 'Approve the field mapping before publishing.'
        : 'Ready to publish.';

  return { publishEnabled, publishTooltip };
}

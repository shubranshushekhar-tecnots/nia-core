import type { GraphPosition, Plan, PlanDiff } from '@nia/schemas';
import { computePlanLayout } from '@nia/schemas';
import { resolveCanvasNode, type CanvasNode, type CanvasEdge, type MappingContext } from './mapping';

/**
 * Phase 7 Session 2 — pure Plan -> ghost-overlay mapper. Output is display-
 * only: FlowCanvas.tsx passes it to <ReactFlow>'s nodes/edges props
 * ALONGSIDE (never merged into) the real useNodesState/useEdgesState
 * arrays, so ghost nodes never reach handleNodesChange/scheduleSave/
 * flowToGraph and can never be accidentally autosaved. Nodes are also
 * marked draggable:false/selectable:false/connectable:false/deletable:false
 * so React Flow itself refuses to let the user mutate them — read-only,
 * per the Phase 7 plan's ghost-panel spec.
 *
 * Ghost node ids reuse the Plan's own plan-local PlanNode.id verbatim
 * (validatePlanStructure already guarantees no collision with an existing
 * GraphNode.id), so Apply can reference the same ids without a remap step
 * for the *proposal* — Apply.ts does its own real-id generation at
 * persistence time, this mapper is purely a preview concern.
 *
 * Placement is delegated to packages/schemas/src/plan.ts's
 * computePlanLayout — the same pure function Apply (apps/api) uses to
 * stamp the persisted GraphNode.position for these nodes, so a node never
 * visually "jumps" between what the ghost showed and where it actually
 * lands after Apply. See that function's doc comment for why
 * PlanNode.position (the LLM-supplied guess) is never trusted here.
 */
export function planToGhostFlow(
  plan: Plan,
  existingNodePositions: GraphPosition[],
  ctx: MappingContext,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const layout = computePlanLayout(plan, existingNodePositions);

  const nodes: CanvasNode[] = plan.nodes.map((planNode) => {
    // PlanNode carries connectionId but not manifestId (see plan.ts —
    // Copilot proposes against a connection, not a specific manifest
    // variant); derive it from the connection the same way a persisted
    // node's manifestId is expected to line up with connections.connector_id.
    const connection = planNode.connectionId ? ctx.connectionsById.get(planNode.connectionId) : undefined;
    const manifestId = connection?.connectorId;
    const resolution = resolveCanvasNode({ manifestId, connectionId: planNode.connectionId, type: planNode.type }, ctx);

    return {
      id: planNode.id,
      type: planNode.type,
      position: layout[planNode.id] ?? planNode.position,
      // Ghost nodes are concatenated into displayNodes (FlowCanvas.tsx)
      // outside of useNodesState's own array, so React Flow's normal
      // ResizeObserver -> onNodesChange("dimensions") -> applyNodeChanges
      // round trip has nowhere to write the measured size back to (that
      // change lands against `nodes`, which never contains ghost ids) —
      // without this, React Flow leaves the node's wrapper permanently at
      // its pre-measurement `visibility: hidden` state. Setting width/
      // height up front (matching GraphFlowNode's own hardcoded 196x80
      // card size) tells React Flow the node is already measured, so it
      // skips that phase entirely.
      width: 196,
      height: 80,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        graphNodeType: planNode.type,
        connectionId: planNode.connectionId,
        manifestId,
        config: planNode.config,
        isGhost: true,
        ...resolution,
      },
    };
  });

  const edges: CanvasEdge[] = plan.edges.map((planEdge) => ({
    id: `ghost-${planEdge.id}`,
    source: planEdge.source,
    target: planEdge.target,
    selectable: false,
    deletable: false,
    style: { stroke: 'var(--copilot-accent)', strokeDasharray: '4 3' },
  }));

  return { nodes, edges };
}

/**
 * Phase 12 — pure PlanDiff -> ghost-overlay mapper, parallel to
 * planToGhostFlow above (that function is untouched; a diff and an
 * add-only Plan need different overlay shapes since a diff can touch
 * already-committed elements, not just propose new ones).
 *
 * Unlike planToGhostFlow, most ops here don't produce a brand-new overlay
 * node/edge — a removeNode/updateNode op targets a REAL node that's
 * already in useNodesState. So this returns two different kinds of
 * output:
 *   - addNodes/addEdges: genuinely new overlay objects (addNode/addEdge
 *     ops), same read-only isGhost:true treatment as planToGhostFlow.
 *   - nodeMarks/edgeMarks: a nodeId/edgeId -> status+label map FlowCanvas
 *     merges onto the REAL node/edge's data (never a separate object),
 *     which is what drives GraphFlowNode's dimmed "Removed" styling and
 *     before/after "Updated" badge.
 *
 * addNode.node already carries a real, final position (unlike Plan's
 * PlanNode.position, which is an LLM guess computePlanLayout overrides) —
 * so no layout pass is needed here.
 */
export type GhostDiffMark = { status: 'removed' | 'updated'; label: string };

export function planDiffToGhostFlow(
  diff: PlanDiff,
  ctx: MappingContext,
): {
  addNodes: CanvasNode[];
  addEdges: CanvasEdge[];
  nodeMarks: Map<string, GhostDiffMark>;
  edgeMarks: Map<string, GhostDiffMark>;
} {
  const addNodes: CanvasNode[] = [];
  const addEdges: CanvasEdge[] = [];
  const nodeMarks = new Map<string, GhostDiffMark>();
  const edgeMarks = new Map<string, GhostDiffMark>();
  const stepChangeCounts = new Map<string, number>();

  for (const op of diff.ops) {
    switch (op.kind) {
      case 'addNode': {
        const resolution = resolveCanvasNode(op.node, ctx);
        addNodes.push({
          id: op.node.id,
          type: op.node.type,
          position: op.node.position,
          width: 196,
          height: 80,
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          data: {
            graphNodeType: op.node.type,
            connectionId: op.node.connectionId,
            manifestId: op.node.manifestId,
            config: op.node.config,
            isGhost: true,
            ...resolution,
          },
        });
        break;
      }
      case 'addEdge': {
        addEdges.push({
          id: `ghost-${op.edge.id}`,
          source: op.edge.source,
          target: op.edge.target,
          selectable: false,
          deletable: false,
          style: { stroke: 'var(--copilot-accent)', strokeDasharray: '4 3' },
        });
        break;
      }
      case 'removeNode':
        nodeMarks.set(op.nodeId, { status: 'removed', label: 'Removed by Copilot' });
        break;
      case 'updateNode':
        if (!nodeMarks.has(op.nodeId)) nodeMarks.set(op.nodeId, { status: 'updated', label: 'Updated by Copilot' });
        break;
      case 'removeEdge':
        edgeMarks.set(op.edgeId, { status: 'removed', label: 'Removed by Copilot' });
        break;
      case 'addStep':
      case 'removeStep':
      case 'updateStep':
      case 'moveStep':
        // Rolled up onto the owning node's mark below — a compact node
        // card has no room for a per-step diff view; the drawer (once it
        // reads ghostDiff, Phase 13) is where step-level detail belongs.
        stepChangeCounts.set(op.nodeId, (stepChangeCounts.get(op.nodeId) ?? 0) + 1);
        break;
      default:
        op satisfies never;
    }
  }

  for (const [nodeId, count] of stepChangeCounts) {
    if (nodeMarks.has(nodeId)) continue; // removeNode/updateNode already covers this node
    nodeMarks.set(nodeId, { status: 'updated', label: count === 1 ? '1 step changed' : `${count} steps changed` });
  }

  return { addNodes, addEdges, nodeMarks, edgeMarks };
}

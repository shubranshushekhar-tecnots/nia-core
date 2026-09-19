import type { GraphPosition, Plan } from '@nia/schemas';
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
    const resolution = resolveCanvasNode({ manifestId, connectionId: planNode.connectionId }, ctx);

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

import type { Node, Edge } from "@xyflow/react";
import type { ConnectorManifest, GraphDoc, GraphEdge, GraphNode, GraphNodeType } from "@nia/schemas";
import { WRITE_OPERATIONS } from "@nia/schemas";
import type { Connection } from "@/lib/connections/types";

/**
 * Pure, two-way GraphDoc <-> React Flow mapper. GraphDoc (packages/schemas)
 * is the persisted source of truth; React Flow's Node[]/Edge[] are a
 * derived view the canvas mutates in memory. No React Flow type ever leaks
 * into packages/schemas — this file is the only place both vocabularies
 * meet.
 *
 * Node.type mirrors GraphNode.type ("source" | "transform" | "destination")
 * 1:1 so React Flow can dispatch to the right custom node component by
 * type string alone.
 *
 * Resolution (does manifestId/connectionId still exist?) and write-lock
 * status are computed once here, eagerly, at map time — not re-derived by
 * every node component from raw ids. That keeps the registry/connections
 * lookup in one place and lets node components render purely off
 * `data.resolved`/`data.unknownReason`/`data.writeLocked` without needing
 * their own access to the manifest registry or connections list.
 */

export type CanvasNodeData = {
  graphNodeType: GraphNodeType;
  connectionId?: string;
  manifestId?: string;
  config: Record<string, unknown>;
  /** false when manifestId is set but not in the registry, or connectionId is set but not in connectionsById. */
  resolved: boolean;
  unknownReason?: string;
  /** true when the resolved manifest supports any write operation. Always false today (all 3 manifests are read-only) — implemented for forward compat, see manifest.ts's WRITE_OPERATIONS. */
  writeLocked: boolean;
  /** Display-only, resolved here so node components never need their own manifest/connections lookup. */
  manifestName?: string;
  connectionLabel?: string;
  /** True only for ghostMapping.ts's Plan-derived overlay nodes — never set by graphToFlow/buildCanvasNode. Drives GraphFlowNode's read-only dashed/translucent styling; never persisted (flowToGraph doesn't read this field back). */
  isGhost?: boolean;
  /**
   * Phase 12 — set only by ghostMapping.ts's planDiffToGhostFlow, on the
   * REAL (already-committed) node/edge a removeNode/updateNode op targets,
   * not on a separate overlay object like isGhost. Drives GraphFlowNode's
   * dimmed "Removed" marker or before/after "Updated" badge. Never
   * persisted (flowToGraph doesn't read this back) and always cleared the
   * same way isGhost's overlay nodes are (FlowCanvas re-derives display
   * nodes from ghostDiff on every render, so this can't leak into a save).
   */
  ghostDiffStatus?: "removed" | "updated";
  ghostDiffLabel?: string;
};

export type CanvasNode = Node<CanvasNodeData, GraphNode["type"]>;
export type CanvasEdge = Edge;

export type MappingContext = {
  manifests: Record<string, ConnectorManifest>;
  connectionsById: Map<string, Connection>;
};

type Resolution = Pick<
  CanvasNodeData,
  "resolved" | "unknownReason" | "writeLocked" | "manifestName" | "connectionLabel"
>;

/**
 * Exported (not just used internally by graphToFlow) so callers that create
 * a brand-new node outside a full GraphDoc load — e.g. FlowCanvas.tsx's
 * palette drag-and-drop handler — can compute the same resolved/
 * unknownReason/writeLocked/manifestName/connectionLabel fields without
 * duplicating this lookup logic.
 */
export function resolveCanvasNode(
  node: Pick<GraphNode, "manifestId" | "connectionId">,
  ctx: MappingContext,
): Resolution {
  if (node.manifestId) {
    const manifest = ctx.manifests[node.manifestId];
    if (!manifest) {
      return { resolved: false, unknownReason: `Unknown tool "${node.manifestId}"`, writeLocked: false };
    }
    const connection = node.connectionId ? ctx.connectionsById.get(node.connectionId) : undefined;
    if (node.connectionId && !connection) {
      return { resolved: false, unknownReason: "Connection not found", writeLocked: false, manifestName: manifest.name };
    }
    const writeLocked = manifest.operations.some((op) => WRITE_OPERATIONS.includes(op));
    return { resolved: true, writeLocked, manifestName: manifest.name, connectionLabel: connection?.displayName };
  }
  if (node.connectionId && !ctx.connectionsById.has(node.connectionId)) {
    return { resolved: false, unknownReason: "Connection not found", writeLocked: false };
  }
  return { resolved: true, writeLocked: false };
}

export function graphToFlow(
  doc: GraphDoc,
  ctx: MappingContext,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: doc.nodes.map((n): CanvasNode => {
      const resolution = resolveCanvasNode(n, ctx);
      return {
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        data: {
          graphNodeType: n.type,
          connectionId: n.connectionId,
          manifestId: n.manifestId,
          config: n.config,
          ...resolution,
        },
      };
    }),
    edges: doc.edges.map(
      (e): CanvasEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      }),
    ),
  };
}

/**
 * Builds a brand-new CanvasNode (e.g. from a PaletteDock drag-and-drop drop)
 * using the same resolution logic graphToFlow applies to persisted nodes.
 * lib/canvas stays independent of components/canvas, so this takes plain
 * manifestId/connectionId/type/position params rather than importing
 * PaletteDock's payload type.
 */
export function buildCanvasNode(
  params: {
    id: string;
    graphNodeType: GraphNodeType;
    manifestId?: string;
    connectionId?: string;
    position: { x: number; y: number };
  },
  ctx: MappingContext,
): CanvasNode {
  const resolution = resolveCanvasNode(params, ctx);
  return {
    id: params.id,
    type: params.graphNodeType,
    position: params.position,
    data: {
      graphNodeType: params.graphNodeType,
      connectionId: params.connectionId,
      manifestId: params.manifestId,
      config: {},
      ...resolution,
    },
  };
}

/**
 * Inverse of graphToFlow. Position is read from the React Flow node
 * (node.position) — React Flow is the live-authoritative source for
 * position once mounted (drag updates node.position via onNodesChange).
 * Every other GraphNode field is read off node.data, which the node
 * components/store update in place when config/connectionId/manifestId
 * change. resolved/unknownReason/writeLocked are derived-only and are not
 * written back into GraphNode.
 *
 * parkedLegacyTriggers is not representable as a node or edge, so it is
 * threaded through untouched by the caller rather than reconstructed here.
 */
export function flowToGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  parkedLegacyTriggers?: GraphDoc["parkedLegacyTriggers"],
): GraphDoc {
  return {
    nodes: nodes.map(
      (n): GraphNode => ({
        id: n.id,
        type: n.data.graphNodeType,
        connectionId: n.data.connectionId,
        manifestId: n.data.manifestId,
        position: { x: n.position.x, y: n.position.y },
        config: n.data.config,
      }),
    ),
    edges: edges.map(
      (e): GraphEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
      }),
    ),
    ...(parkedLegacyTriggers ? { parkedLegacyTriggers } : {}),
  };
}

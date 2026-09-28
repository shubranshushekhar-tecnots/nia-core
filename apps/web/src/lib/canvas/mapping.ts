import type { Node, Edge } from "@xyflow/react";
import type { CheckResult, ConnectorManifest, GraphDoc, GraphEdge, GraphNode, GraphNodeType } from "@nia/schemas";
import { WRITE_OPERATIONS } from "@nia/schemas";
import { connectionRegion, connectionSecondaryLabel, type Connection } from "@/lib/connections/types";

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
 * Resolution (does manifestId/connectionId still exist?) is computed once
 * here, eagerly, at map time — not re-derived by every node component from
 * raw ids. That keeps the registry/connections lookup in one place and lets
 * node components render purely off `data.resolved`/`data.unknownReason`
 * without needing their own access to the manifest registry or connections
 * list.
 *
 * `data.status` (kind + message) is the single, live source of truth for a
 * node's visible state — see `applyCheckResults` below. It replaces a
 * former static `writeLocked` capability flag that only reflected whether a
 * connector type CAN offer a write verb, never whether an actual write
 * grant existed — the root cause of the node footer disagreeing with the
 * real `grants` check. `applyCheckResults` is applied on top of
 * graphToFlow/buildCanvasNode's output by the caller (FlowCanvas.tsx),
 * since it needs the latest check run + live run state, neither of which
 * this pure module has access to.
 */

export type CanvasNodeData = {
  graphNodeType: GraphNodeType;
  connectionId?: string;
  manifestId?: string;
  config: Record<string, unknown>;
  /** false when manifestId is set but not in the registry, or connectionId is set but not in connectionsById. */
  resolved: boolean;
  unknownReason?: string;
  /** Display-only, resolved here so node components never need their own manifest/connections lookup. */
  manifestName?: string;
  connectionLabel?: string;
  /** Best-effort, regex-derived from the connection's host — see connectionRegion's doc comment. Undefined when unparseable; never invented. */
  region?: string;
  /** Live node status merged in by applyCheckResults; undefined until the first merge pass (e.g. a brand-new node this render hasn't been through FlowCanvas's displayNodes memo yet) — components must fall back to "ready" in that case. */
  status?: NodeStatus;
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

type Resolution = Pick<CanvasNodeData, "resolved" | "unknownReason" | "manifestName" | "connectionLabel" | "region">;

/**
 * Exported (not just used internally by graphToFlow) so callers that create
 * a brand-new node outside a full GraphDoc load — e.g. FlowCanvas.tsx's
 * palette drag-and-drop handler — can compute the same resolved/
 * unknownReason/manifestName/connectionLabel fields without duplicating
 * this lookup logic.
 */
export function resolveCanvasNode(
  node: Pick<GraphNode, "manifestId" | "connectionId" | "type">,
  ctx: MappingContext,
): Resolution {
  if (node.manifestId) {
    const manifest = ctx.manifests[node.manifestId];
    if (!manifest) {
      return { resolved: false, unknownReason: `Unknown tool "${node.manifestId}"` };
    }
    const connection = node.connectionId ? ctx.connectionsById.get(node.connectionId) : undefined;
    if (node.connectionId && !connection) {
      return { resolved: false, unknownReason: "Connection not found", manifestName: manifest.name };
    }
    // Item 6.2 (fix-chain plan): same as NodesRail.tsx's palette entries —
    // append the connection's host/database so two same-named connections
    // are distinguishable once placed on canvas (GraphFlowNode's pill,
    // NodeDrawer's header).
    const secondary = connection ? connectionSecondaryLabel(connection) : undefined;
    const connectionLabel = connection ? (secondary ? `${connection.displayName} (${secondary})` : connection.displayName) : undefined;
    const region = connection ? connectionRegion(connection) : undefined;
    return { resolved: true, manifestName: manifest.name, connectionLabel, region };
  }
  if (node.connectionId && !ctx.connectionsById.has(node.connectionId)) {
    return { resolved: false, unknownReason: "Connection not found" };
  }
  return { resolved: true };
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
  const resolution = resolveCanvasNode({ manifestId: params.manifestId, connectionId: params.connectionId, type: params.graphNodeType }, ctx);
  // Seeds a role-appropriate initial verb instead of leaving config: {}
  // (whose zod default is "read" for every node, source or destination —
  // see nodeConfig.ts's SourceDestConfig). Without this, a freshly-dropped
  // destination node persists operation: "read" until its drawer is opened,
  // which both looks wrong and silently bypasses checkGrants' write-grant
  // gate (checks.ts only checks write verbs).
  const manifest = params.manifestId ? ctx.manifests[params.manifestId] : undefined;
  const initialOperation = manifest?.operations.find((op) =>
    params.graphNodeType === "destination" ? WRITE_OPERATIONS.includes(op) : !WRITE_OPERATIONS.includes(op),
  );
  return {
    id: params.id,
    type: params.graphNodeType,
    position: params.position,
    data: {
      graphNodeType: params.graphNodeType,
      connectionId: params.connectionId,
      manifestId: params.manifestId,
      config: initialOperation ? { operation: initialOperation } : {},
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
 * change. resolved/unknownReason/status are derived-only and are not
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

// ---------------------------------------------------------------------------
// Live node status (workflow canvas redesign) — one merge pass, one source
// of truth for the node footer, NodeDrawer's alert card, and (indirectly,
// since both read the same latestCheckRun) the Checks drawer.
// ---------------------------------------------------------------------------

export type NodeStatusKind = "ready" | "running" | "succeeded" | "needsAction" | "failed" | "disabled";
export type NodeStatus = { kind: NodeStatusKind; message: string };

/**
 * Mirrors FlowCanvas.tsx's per-destination run-stream state exactly (same
 * shape, re-exported from here so both that component and this module share
 * one definition instead of two structurally-identical local types).
 */
export type NodeRunState =
  | { status: "starting" }
  | { status: "running"; totalRowsProcessed: number }
  | { status: "cancelling"; totalRowsProcessed: number }
  | { status: "cancelled"; totalRowsProcessed: number }
  | { status: "done"; totalRowsProcessed: number; durationMs: number }
  | { status: "error"; message: string };

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusFromRun(run: NodeRunState): NodeStatus {
  switch (run.status) {
    case "starting":
      return { kind: "running", message: "Starting…" };
    case "running":
      return { kind: "running", message: `Running — ${run.totalRowsProcessed.toLocaleString()} rows` };
    case "cancelling":
      return { kind: "running", message: `Cancelling — ${run.totalRowsProcessed.toLocaleString()} rows` };
    case "cancelled":
      return { kind: "failed", message: `Cancelled — ${run.totalRowsProcessed.toLocaleString()} rows` };
    case "done":
      return { kind: "succeeded", message: `${run.totalRowsProcessed.toLocaleString()} rows in ${formatDuration(run.durationMs)}` };
    case "error":
      return { kind: "failed", message: run.message };
  }
}

/** Worst-first: a fail always wins over a warn for the same node. */
function statusFromCheckResults(results: CheckResult[]): NodeStatus {
  const fail = results.find((r) => r.status === "fail");
  if (fail) return { kind: "needsAction", message: fail.message };
  const warn = results.find((r) => r.status === "warn");
  if (warn) return { kind: "needsAction", message: warn.message };
  return { kind: "ready", message: "Ready" };
}

/**
 * Merges live run state and the latest check run's per-node results onto
 * each node's `data.status` — this is the fix for the "node says 'Needs
 * write grant' while the grants check passes" bug: both now read off the
 * exact same CheckResult[] (`checkGrants`'s real write_grants lookup, via
 * apps/api), instead of the node footer separately deriving a static
 * "this connector type supports writing" capability flag. Priority order:
 * 1) unresolved (bad manifestId/connectionId) always wins — nothing else is
 *    meaningful to show once a node's own referenced data is gone.
 * 2) a live run touching this node (more current than any check run).
 * 3) the worst matching CheckResult for this node's id.
 * 4) "ready" — either checks haven't run yet, or every check that mentions
 *    this node passed.
 * Called by FlowCanvas.tsx wherever it builds `displayNodes`, since only
 * that component has both `latestCheckRun` and `runStates` in scope.
 */
export function applyCheckResults(
  nodes: CanvasNode[],
  results: CheckResult[] | null | undefined,
  runStates: Record<string, NodeRunState>,
): CanvasNode[] {
  return nodes.map((node) => {
    if (!node.data.resolved) {
      return { ...node, data: { ...node.data, status: { kind: "disabled", message: node.data.unknownReason ?? "Unresolved" } } };
    }
    const run = runStates[node.id];
    if (run) {
      return { ...node, data: { ...node.data, status: statusFromRun(run) } };
    }
    const nodeResults = (results ?? []).filter((r) => r.nodeId === node.id);
    return { ...node, data: { ...node.data, status: statusFromCheckResults(nodeResults) } };
  });
}

import type { Edge, Node } from "@xyflow/react";
import type { GraphNodeType } from "@nia/schemas";

/**
 * Shared, UI-agnostic status vocabulary for a canvas node's footer dot —
 * mirrors apps/web/src/lib/canvas/mapping.ts's NodeStatusKind exactly (not
 * imported from there: that module is intertwined with GraphDoc/live-run
 * merging that stays web-only, per the plan). Any caller that wants to show
 * a node's status (website's live FlowCanvas, or this package's read-only
 * ReadOnlyCanvas) maps its own state into this same shape.
 */
export type NodeStatusKind = "ready" | "running" | "succeeded" | "needsAction" | "failed" | "disabled";

export type NodeStatus = { kind: NodeStatusKind; message: string };

/**
 * Display-only fields a read-only canvas needs to render a node card —
 * deliberately narrower than apps/web's CanvasNodeData (no `config`, no
 * `connectionId`/`manifestId`, no ghost-diff fields): this package has no
 * editable-canvas concept, and a sanitized server response (agent-bridge's
 * GET /agent-api/workflows/:id/graph) should never need to carry raw ids or
 * the node's raw config object just to satisfy this type.
 */
export type ReadOnlyCanvasNodeData = {
  graphNodeType: GraphNodeType;
  manifestId?: string;
  manifestName?: string;
  connectionLabel?: string;
  region?: string;
  entityLabel?: string;
  writeModeLabel?: string;
  /** false when the node's manifestId/connectionId no longer resolve. */
  resolved: boolean;
  unknownReason?: string;
  /** Undefined renders as "ready" — no live per-node status source exists outside apps/web today (see plan's "Known limitation"). */
  status?: NodeStatus;
};

export type ReadOnlyCanvasNode = Node<ReadOnlyCanvasNodeData, GraphNodeType>;

export type CanvasEdgeData = {
  label?: string;
  variant?: "default" | "running" | "failed";
};

export type ReadOnlyCanvasEdge = Edge<CanvasEdgeData>;

'use client';

import { NodeToolbar, Position, useStore, type ReactFlowState } from '@xyflow/react';
import type { CanvasNode } from '@/lib/canvas/mapping';
import type { CheckResult } from '@nia/schemas';
import NodeDrawer from './NodeDrawer';
import { nodePopoverShellStyle, nodePopoverWidth } from './styles';

/**
 * Node-anchored popover shell (Task 2, decision 2). Wraps NodeDrawer.tsx's
 * content UNCHANGED — no restructuring of its internals, restyle only to
 * the extent the recorded tokens require (drawerStyle's own outer
 * position/border/shadow no longer applies since this shell now owns that;
 * NodeDrawer's *internal* markup below its root div is untouched).
 *
 * HARD CONSTRAINT: must not unmount/remount on canvas pan or zoom. This is
 * satisfied by:
 *   1. Being conditionally rendered/keyed on `selectedNodeId` only (same as
 *      the drawer was before) — panning/zooming the canvas never changes
 *      which node is selected, so this condition/key is stable across
 *      pan/zoom.
 *   2. Using React Flow's own `NodeToolbar` for positioning, which
 *      subscribes to the store's viewport/node-position state and
 *      repositions via re-render (style recalculation), not remount — this
 *      is exactly what NodeToolbar is built for (see @xyflow/react docs).
 *   3. The `flip` calculation below is itself a `useStore` selector — it
 *      re-renders this component on pan/zoom, it never keys or
 *      conditionally mounts anything on viewport/transform state.
 */

type PopoverPlacement = { flipX: boolean; alignEnd: boolean; maxHeight: number };

// Bottom dock (ChecksDock) reserves ~40px, plus a margin so the popover
// never touches the canvas edges.
const RESERVED_BOTTOM = 56;
const MIN_POPOVER_HEIGHT = 240;

function selectPlacement(nodeId: string): (state: ReactFlowState) => PopoverPlacement {
  return (state) => {
    const internalNode = state.nodeLookup.get(nodeId);
    if (!internalNode) return { flipX: false, alignEnd: false, maxHeight: MIN_POPOVER_HEIGHT };
    const [tx, ty, zoom] = state.transform;
    const nodeWidth = internalNode.measured?.width ?? internalNode.width ?? 200;
    const nodeHeight = internalNode.measured?.height ?? internalNode.height ?? 80;
    const margin = 16;

    const screenRight = internalNode.internals.positionAbsolute.x * zoom + tx + nodeWidth * zoom;
    // Not enough room to the right of the node for the popover -> flip to the left instead.
    const flipX = screenRight + margin + nodePopoverWidth > state.width;

    const screenTop = internalNode.internals.positionAbsolute.y * zoom + ty;
    const screenMidY = screenTop + (nodeHeight * zoom) / 2;
    // Node sits in the bottom half of the canvas -> anchor the popover's
    // bottom edge to the node instead of its top, so a tall popover grows
    // upward into free space instead of downward under the checks dock or
    // past the canvas edge (real, reproducible cause of "sometimes not
    // visible" — align="start" always grew downward before this fix).
    const alignEnd = screenMidY > state.height / 2;

    // Clamp height to whichever half of the container the popover grows
    // into, rather than assuming a fixed 100vh budget (which over-counts
    // the app's own header chrome and the checks dock).
    const available = alignEnd ? screenTop + nodeHeight * zoom : state.height - screenTop;
    const maxHeight = Math.max(MIN_POPOVER_HEIGHT, available - RESERVED_BOTTOM);

    return { flipX, alignEnd, maxHeight };
  };
}

export default function NodePopover({
  node,
  workflowId,
  upstreamSource,
  checkResults,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  workflowId: string;
  upstreamSource?: { connectionId?: string; manifestId?: string };
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { flipX, alignEnd, maxHeight } = useStore(
    selectPlacement(node.id),
    (a, b) => a.flipX === b.flipX && a.alignEnd === b.alignEnd && a.maxHeight === b.maxHeight,
  );

  return (
    <NodeToolbar
      nodeId={node.id}
      isVisible
      position={flipX ? Position.Left : Position.Right}
      align={alignEnd ? 'end' : 'start'}
      offset={16}
      style={{ ...nodePopoverShellStyle, maxHeight }}
    >
      <NodeDrawer
        node={node}
        workflowId={workflowId}
        upstreamSource={upstreamSource}
        checkResults={checkResults}
        onConfigChange={onConfigChange}
        onDelete={onDelete}
        onClose={onClose}
      />
    </NodeToolbar>
  );
}

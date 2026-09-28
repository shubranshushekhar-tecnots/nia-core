'use client';

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { CanvasEdge as CanvasEdgeModel } from '@/lib/canvas/mapping';

// Custom edge registered as FlowCanvas.tsx's default edgeType. Edges carry
// no persisted styling data (GraphEdge has no such field, and this plan
// makes no schema changes to it) — `data.variant`/`data.label` are computed
// per-render by FlowCanvas from the same live check-results/run-state merge
// that drives GraphFlowNode's footer, never invented here.
export type CanvasEdgeData = {
  // e.g. "public → public" when both ends' schema is known; omitted
  // (no label rendered) when either side's schema can't be resolved —
  // no `schema` field exists on GraphNode.config anywhere in this codebase
  // today, so in practice this is currently always undefined (data gap).
  label?: string;
  variant?: 'default' | 'running' | 'failed';
};

const VARIANT_STYLE: Record<NonNullable<CanvasEdgeData['variant']>, { stroke: string; dash?: string; animated?: boolean }> = {
  default: { stroke: 'var(--line-200)' },
  running: { stroke: 'var(--acc)', animated: true },
  failed: { stroke: 'var(--danger)', dash: '2 3' },
};

export default function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  markerEnd,
}: EdgeProps<CanvasEdgeModel & { data?: CanvasEdgeData }>) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const variant = data?.variant ?? 'default';
  const { stroke, dash } = VARIANT_STYLE[variant];

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? 'var(--acc)' : stroke,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: dash,
        }}
        className={variant === 'running' ? 'nia-edge-running' : undefined}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--ink-200)',
              background: 'var(--surface)',
              border: '1px solid var(--line-200)',
              borderRadius: 999,
              padding: '2px 8px',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

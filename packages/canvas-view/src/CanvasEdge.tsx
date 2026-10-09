'use client';

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { CanvasEdgeData, ReadOnlyCanvasEdge } from './types.js';

// Custom edge, registered as both apps/web's FlowCanvas.tsx and this
// package's ReadOnlyCanvas.tsx default edgeType — the component itself
// never reads any store/editable-canvas state, so it moved here unchanged
// rather than being copy-pasted. Edges carry no persisted styling data
// (GraphEdge has no such field) — `data.variant`/`data.label` are computed
// per-render by the caller from whatever live state it has (apps/web's
// check-results/run-state merge; this package's callers currently never
// set them, so edges render in their `default` variant with no label).
export type { CanvasEdgeData };

const VARIANT_STYLE: Record<NonNullable<CanvasEdgeData['variant']>, { stroke: string; dash?: string; animated?: boolean }> = {
  default: { stroke: 'var(--nx-line)' },
  running: { stroke: 'var(--nx-blue-panel)', animated: true },
  failed: { stroke: 'var(--nx-danger)', dash: '2 3' },
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
}: EdgeProps<ReadOnlyCanvasEdge>) {
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
          stroke: selected ? 'var(--nx-blue-panel)' : stroke,
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
              fontFamily: 'var(--nx-font-mono)',
              fontSize: 11,
              color: 'var(--nx-ink-2)',
              background: 'var(--nx-surface)',
              border: '1px solid var(--nx-line)',
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

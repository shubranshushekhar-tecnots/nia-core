'use client';

import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import type { CanvasNode } from '@/lib/canvas/mapping';

// One component for all 3 GraphNodeTypes (source/transform/destination) —
// branches on data.graphNodeType for color/handle layout, per the plan's
// "one GraphFlowNode.tsx branching on data.graphNodeType" option (chosen
// over 3 near-identical components).
export const KIND_COLOR: Record<CanvasNode['data']['graphNodeType'], string> = {
  source: 'var(--c-data)',
  transform: 'var(--c-condition)',
  destination: 'var(--c-action)',
};

export const KIND_LABEL: Record<CanvasNode['data']['graphNodeType'], string> = {
  source: 'Source',
  transform: 'Transform',
  destination: 'Destination',
};

export default function GraphFlowNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow();
  const color = data.resolved ? KIND_COLOR[data.graphNodeType] : 'var(--warn)';
  const showTargetHandle = data.graphNodeType !== 'source';
  const showSourceHandle = data.graphNodeType !== 'destination';

  return (
    <div
      title={data.unknownReason}
      style={{
        position: 'relative',
        width: 200,
        borderRadius: 10,
        background: data.resolved ? 'var(--surface)' : 'var(--warn-bg)',
        border: `1.5px solid ${selected ? color : data.resolved ? 'var(--panel-line)' : 'var(--warn-bd)'}`,
        boxShadow: selected ? `0 0 0 3px ${color}22` : 'var(--amb)',
        padding: '10px 12px',
        boxSizing: 'border-box',
        cursor: 'grab',
        userSelect: 'none',
      }}
    >
      {showTargetHandle && (
        <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: 'var(--surface)', border: `2px solid ${color}` }} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: 'none' }} aria-hidden />
        <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{KIND_LABEL[data.graphNodeType]}</span>
        {data.writeLocked && (
          <span
            title="Requires write grant — Phase 6"
            style={{
              marginLeft: 4,
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--warn)',
              background: 'var(--warn-bg)',
              border: '1px solid var(--warn-bd)',
              borderRadius: 999,
              padding: '1px 6px',
            }}
          >
            Locked
          </span>
        )}
        <button
          type="button"
          aria-label="Delete node"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
          style={{ marginLeft: 'auto', width: 18, height: 18, border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          {'\u2715'}
        </button>
      </div>

      <div style={{ fontSize: 13.5, fontWeight: 600, color: data.resolved ? 'var(--ink)' : 'var(--warn)', marginTop: 4 }}>
        {data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown')}
      </div>
      {data.connectionLabel && (
        <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginTop: 2 }}>{data.connectionLabel}</div>
      )}

      {showSourceHandle && (
        <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: 'var(--surface)', border: `2px solid ${color}` }} />
      )}
    </div>
  );
}

'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { getConnectorIcon } from './icons';

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

// Delete no longer lives on the card itself — it moved to the floating
// NodeConfigPanel's header ribbon (NodeDrawer.tsx's onDelete), which is
// already reachable the moment a node is selected. useReactFlow's
// deleteElements is therefore no longer needed here.
export default function GraphFlowNode({ data, selected }: NodeProps<CanvasNode>) {
  const color = data.resolved ? KIND_COLOR[data.graphNodeType] : 'var(--warn)';
  const showTargetHandle = data.graphNodeType !== 'source';
  const showSourceHandle = data.graphNodeType !== 'destination';
  const isGhost = data.isGhost === true;
  const Icon = getConnectorIcon(data.manifestId, data.graphNodeType);

  return (
    <div
      title={isGhost ? 'Proposed by Copilot — read-only until applied' : data.unknownReason}
      style={{
        position: 'relative',
        width: 196,
        height: 80,
        borderRadius: 12,
        background: data.resolved ? 'var(--surface)' : 'var(--warn-bg)',
        border: isGhost ? 'var(--provisional-border)' : `1.5px solid ${selected ? 'var(--acc)' : data.resolved ? 'var(--card-line)' : 'var(--warn-bd)'}`,
        boxShadow: isGhost ? 'none' : selected ? `0 0 0 3px var(--acc-soft), var(--card-shadow)` : 'var(--card-shadow)',
        opacity: isGhost ? 'var(--ghost-opacity)' : 1,
        padding: '10px 12px',
        boxSizing: 'border-box',
        cursor: isGhost ? 'default' : 'grab',
        userSelect: 'none',
      }}
    >
      {showTargetHandle && (
        <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: 'var(--surface)', border: `2px solid ${color}` }} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', color, flex: 'none' }} aria-hidden>
          <Icon size={13} />
        </span>
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
        {isGhost && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--copilot-accent)',
              background: 'var(--surface)',
              border: '1px solid var(--copilot-accent)',
              borderRadius: 999,
              padding: '1px 6px',
            }}
          >
            Proposed
          </span>
        )}
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

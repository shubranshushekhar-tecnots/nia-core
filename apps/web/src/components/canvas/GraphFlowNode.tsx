'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { useCanvasStore } from '@/lib/canvas/store';
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
export default function GraphFlowNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const setContextMenu = useCanvasStore((s) => s.setContextMenu);
  const hasConnection = Boolean(data.resolved && data.connectionId);
  const color = data.resolved ? KIND_COLOR[data.graphNodeType] : 'var(--warn)';
  // Handle ring color is a simpler 2-bucket scheme than KIND_COLOR's 3
  // icon colors — source vs. everything downstream of it.
  const handleColor = data.graphNodeType === 'source' ? 'var(--handle-ring-source)' : 'var(--handle-ring-sink)';
  const showTargetHandle = data.graphNodeType !== 'source';
  const showSourceHandle = data.graphNodeType !== 'destination';
  const isGhost = data.isGhost === true;
  const diffStatus = data.ghostDiffStatus;
  const isDiffRemoved = diffStatus === 'removed';
  const Icon = getConnectorIcon(data.manifestId, data.graphNodeType);

  const openMenuAt = (x: number, y: number) => {
    setContextMenu({ x, y, nodeId: id, graphNodeType: data.graphNodeType, hasConnection });
  };

  return (
    <div
      title={isGhost ? 'Proposed by Copilot — read-only until applied' : (data.ghostDiffLabel ?? data.unknownReason)}
      tabIndex={isGhost ? undefined : 0}
      onKeyDown={
        isGhost
          ? undefined
          : (e) => {
              if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                openMenuAt(rect.left, rect.bottom);
              }
            }
      }
      style={{
        position: 'relative',
        width: 196,
        height: 80,
        borderRadius: 12,
        background: data.resolved ? 'var(--surface)' : 'var(--warn-bg)',
        border: isGhost
          ? 'var(--provisional-border)'
          : diffStatus
            ? '1.5px dashed var(--copilot-accent)'
            : selected
              ? '1.5px solid var(--acc)'
              : data.resolved
                ? '1px solid var(--card-line)'
                : '1.5px solid var(--warn-bd)',
        boxShadow: isGhost ? 'none' : selected ? `0 0 0 3px var(--acc-soft), var(--card-shadow)` : 'var(--card-shadow)',
        opacity: isGhost || isDiffRemoved ? 'var(--ghost-opacity)' : 1,
        padding: '10px 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: isGhost ? 'default' : 'grab',
        userSelect: 'none',
      }}
    >
      {!isGhost && (
        <button
          type="button"
          aria-haspopup="menu"
          aria-label="Node actions"
          title="Node actions"
          className="nodrag"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            openMenuAt(rect.left, rect.bottom);
          }}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 18,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--ink4)',
            cursor: 'pointer',
            borderRadius: 4,
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ⋯
        </button>
      )}
      {showTargetHandle && (
        <Handle type="target" position={Position.Left} style={{ width: 8, height: 8, background: 'var(--surface)', border: `1.5px solid ${handleColor}` }} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', color, flex: 'none' }} aria-hidden>
          <Icon size={13} />
        </span>
        <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{KIND_LABEL[data.graphNodeType]}</span>
        {data.writeLocked && (
          <span
            title="Write access requires a confirmed write grant"
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
            Needs write grant
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
        {!isGhost && diffStatus && (
          <span
            title={data.ghostDiffLabel}
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--copilot-accent)',
              background: 'var(--surface)',
              border: '1px solid var(--copilot-accent)',
              borderRadius: 999,
              padding: '1px 6px',
              textDecoration: isDiffRemoved ? 'line-through' : 'none',
            }}
          >
            {isDiffRemoved ? 'Removed' : 'Updated'}
          </span>
        )}
      </div>

      <div
        title={data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown')}
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: data.resolved ? 'var(--ink)' : 'var(--warn)',
          marginTop: 4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown')}
      </div>
      {data.connectionLabel && (
        <div
          title={data.connectionLabel}
          style={{
            fontSize: 11.5,
            color: 'var(--ink4)',
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {data.connectionLabel}
        </div>
      )}
      {!isGhost && diffStatus === 'updated' && data.ghostDiffLabel && (
        <div
          title={data.ghostDiffLabel}
          style={{
            fontSize: 10.5,
            color: 'var(--copilot-accent)',
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {data.ghostDiffLabel}
        </div>
      )}

      {showSourceHandle && (
        <Handle type="source" position={Position.Right} style={{ width: 8, height: 8, background: 'var(--surface)', border: `1.5px solid ${handleColor}` }} />
      )}
    </div>
  );
}

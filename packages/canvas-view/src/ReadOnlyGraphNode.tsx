'use client';

import { Position, type NodeProps } from '@xyflow/react';
import type { ReadOnlyCanvasNode, NodeStatusKind } from './types.js';
import { getConnectorIcon } from './icons.js';
import { Port } from './Port.js';

// A different component from apps/web's GraphFlowNode.tsx, not a copy of
// it with a flag: there is nothing to click, drag, or right-click here
// (no useCanvasStore, no context menu, no Copilot ghost-diff badges — none
// of that applies to a read-only view), so it doesn't carry any of that
// component's state/event wiring. Visual language (header/body/footer,
// tile colors, status dot) is ported to match, per the plan.
export const KIND_LABEL: Record<ReadOnlyCanvasNode['data']['graphNodeType'], string> = {
  source: 'Source',
  transform: 'Transform',
  destination: 'Destination',
};

function tileColors(kind: ReadOnlyCanvasNode['data']['graphNodeType']) {
  return kind === 'transform'
    ? { bg: 'var(--nx-ink)', icon: 'var(--nx-bg)' }
    : { bg: 'var(--nx-raised)', icon: 'var(--nx-blue-panel)' };
}

const STATUS_STYLE: Record<NodeStatusKind, { dot: string; text: string; border: string }> = {
  ready: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-2)', border: 'var(--nx-line)' },
  running: { dot: 'var(--nx-blue-panel)', text: 'var(--nx-blue-panel)', border: 'var(--nx-blue-panel)' },
  succeeded: { dot: 'var(--nx-success)', text: 'var(--nx-success)', border: 'var(--nx-line)' },
  needsAction: { dot: 'var(--nx-warn)', text: 'var(--nx-warn)', border: 'var(--nx-warn)' },
  failed: { dot: 'var(--nx-danger)', text: 'var(--nx-danger)', border: 'var(--nx-danger)' },
  disabled: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-3)', border: 'var(--nx-line-inner)' },
};

export default function ReadOnlyGraphNode({ data, selected }: NodeProps<ReadOnlyCanvasNode>) {
  const showTargetHandle = data.graphNodeType !== 'source';
  const showSourceHandle = data.graphNodeType !== 'destination';
  const Icon = getConnectorIcon(data.manifestId, data.graphNodeType);
  const { bg: tileBg, icon: tileIcon } = tileColors(data.graphNodeType);

  const statusKind: NodeStatusKind = !data.resolved ? 'disabled' : (data.status?.kind ?? 'ready');
  const statusMessage = !data.resolved ? (data.unknownReason ?? 'Unresolved') : (data.status?.message ?? 'Ready');
  const statusStyle = STATUS_STYLE[statusKind];

  const title = data.resolved ? (data.connectionLabel ?? data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown');

  const border = selected ? '1.5px solid var(--nx-blue-panel)' : `1px solid ${statusStyle.border}`;

  return (
    <div
      title={title}
      style={{
        position: 'relative',
        width: 256,
        minHeight: 64,
        borderRadius: 12,
        background: 'var(--nx-surface)',
        border,
        boxShadow: selected ? '0 0 0 3px var(--nx-blue-tint), var(--card-shadow)' : 'var(--card-shadow)',
        opacity: statusKind === 'disabled' ? 'var(--ghost-opacity)' : 1,
        boxSizing: 'border-box',
        overflow: 'visible',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {showTargetHandle && <Port type="target" position={Position.Left} />}

      {/* Header — icon tile / role label / title. No overflow menu: nothing to act on here. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 64, padding: '0 12px', borderBottom: '1px solid var(--nx-line-inner)' }}>
        <span
          aria-hidden
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 34, height: 34, borderRadius: 8, background: tileBg, color: tileIcon }}
        >
          <Icon size={16} />
        </span>
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <div style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '.04em', color: 'var(--nx-ink-3)', textTransform: 'uppercase' }}>
            {KIND_LABEL[data.graphNodeType]}
          </div>
          <div
            title={title}
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: data.resolved ? 'var(--nx-ink)' : 'var(--nx-warn)',
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </div>
        </div>
      </div>

      {/* Body — up to 3 rows, omitted when the value doesn't exist */}
      {(data.manifestName || data.region || data.entityLabel || data.writeModeLabel) && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.manifestName && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Provider</span>
              <span style={{ fontFamily: 'var(--nx-font-mono)', color: 'var(--nx-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.manifestName}</span>
            </div>
          )}
          {data.region && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Region</span>
              <span style={{ fontFamily: 'var(--nx-font-mono)', color: 'var(--nx-ink-2)' }}>{data.region}</span>
            </div>
          )}
          {data.entityLabel && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Table</span>
              <span style={{ fontFamily: 'var(--nx-font-mono)', color: 'var(--nx-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.entityLabel}</span>
            </div>
          )}
          {data.writeModeLabel && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Write mode</span>
              <span style={{ color: 'var(--nx-ink-2)' }}>{data.writeModeLabel}</span>
            </div>
          )}
        </div>
      )}

      {/* Footer — single status line. No "Retry"/"Review" action button: nothing to act on in a read-only view. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderTop: '1px solid var(--nx-line-inner)',
          fontSize: 11.5,
        }}
      >
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: statusStyle.dot, flex: 'none' }} />
        <span title={statusMessage} style={{ color: statusStyle.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
          {statusMessage}
        </span>
      </div>

      {showSourceHandle && <Port type="source" position={Position.Right} />}
    </div>
  );
}

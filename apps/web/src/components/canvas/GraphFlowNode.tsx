'use client';

import { Position, type NodeProps } from '@xyflow/react';
import type { CanvasNode, NodeStatusKind } from '@/lib/canvas/mapping';
import { useCanvasStore } from '@/lib/canvas/store';
import { getConnectorIcon, Port } from '@nia/canvas-view';

// One component for all 3 GraphNodeTypes (source/transform/destination) —
// branches on data.graphNodeType for color/handle layout, per the plan's
// "one GraphFlowNode.tsx branching on data.graphNodeType" option (chosen
// over 3 near-identical components).
export const KIND_LABEL: Record<CanvasNode['data']['graphNodeType'], string> = {
  source: 'Source',
  transform: 'Transform',
  destination: 'Destination',
};

// Still exported: NodeDrawer.tsx's header ribbon icon reads this directly
// (identityColor). Kept in sync with the new tile-color scheme below rather
// than the old 3-color KIND_COLOR so both surfaces agree.
export const KIND_COLOR: Record<CanvasNode['data']['graphNodeType'], string> = {
  source: 'var(--nx-blue-panel)',
  transform: 'var(--nx-bg)',
  destination: 'var(--nx-blue-panel)',
};

// Icon tile colors: source/destination render as a quiet mono tile
// (--nx-raised bg / --nx-blue-panel icon); transform is inverted for
// contrast (--nx-ink bg / --nx-bg icon) — per Step 5 answer #9 ("proceed
// as proposed").
function tileColors(kind: CanvasNode['data']['graphNodeType']) {
  return kind === 'transform'
    ? { bg: 'var(--nx-ink)', icon: 'var(--nx-bg)' }
    : { bg: 'var(--nx-raised)', icon: 'var(--nx-blue-panel)' };
}

const STATUS_STYLE: Record<
  NodeStatusKind,
  { dot: string; text: string; border: string; shadow: string; actionLabel?: string }
> = {
  ready: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-2)', border: 'var(--nx-line)', shadow: 'var(--card-shadow)' },
  running: { dot: 'var(--nx-blue-panel)', text: 'var(--nx-blue-panel)', border: 'var(--nx-blue-panel)', shadow: '0 0 0 3px var(--nx-blue-tint), var(--card-shadow)' },
  succeeded: { dot: 'var(--nx-success)', text: 'var(--nx-success)', border: 'var(--nx-line)', shadow: 'var(--card-shadow)' },
  needsAction: { dot: 'var(--nx-warn)', text: 'var(--nx-warn)', border: 'var(--nx-warn)', shadow: 'var(--card-shadow)', actionLabel: 'Review' },
  failed: { dot: 'var(--nx-danger)', text: 'var(--nx-danger)', border: 'var(--nx-danger)', shadow: 'var(--card-shadow)', actionLabel: 'Retry' },
  disabled: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-3)', border: 'var(--nx-line-inner)', shadow: 'none' },
};

// Best-effort, additive-only read of SourceDestConfig's `entity`/`writeMode`
// (packages/schemas/src/nodeConfig.ts) — node.data.config is untyped
// (`Record<string, unknown>`) at this layer, so this narrows defensively
// rather than trusting the shape; absent/malformed fields simply render no
// row (never invented).
function readEntityLabel(config: Record<string, unknown>): string | undefined {
  const entity = config.entity;
  if (entity && typeof entity === 'object' && 'name' in entity) {
    const namespace = 'namespace' in entity && typeof entity.namespace === 'string' ? entity.namespace : undefined;
    const name = typeof (entity as { name: unknown }).name === 'string' ? (entity as { name: string }).name : undefined;
    if (!name) return undefined;
    return namespace ? `${namespace}.${name}` : name;
  }
  return undefined;
}

function readWriteMode(config: Record<string, unknown>): string | undefined {
  return config.writeMode === 'direct' ? 'Direct write' : config.writeMode === 'staged' ? 'Staged write' : undefined;
}

// Delete no longer lives on the card itself — it moved to the floating
// NodeConfigPanel's header ribbon (NodeDrawer.tsx's onDelete), which is
// already reachable the moment a node is selected. useReactFlow's
// deleteElements is therefore no longer needed here.
export default function GraphFlowNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const setContextMenu = useCanvasStore((s) => s.setContextMenu);
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);
  const hasConnection = Boolean(data.resolved && data.connectionId);
  const showTargetHandle = data.graphNodeType !== 'source';
  const showSourceHandle = data.graphNodeType !== 'destination';
  const isGhost = data.isGhost === true;
  const diffStatus = data.ghostDiffStatus;
  const isDiffRemoved = diffStatus === 'removed';
  const Icon = getConnectorIcon(data.manifestId, data.graphNodeType);
  const { bg: tileBg, icon: tileIcon } = tileColors(data.graphNodeType);

  const statusKind: NodeStatusKind = !data.resolved ? 'disabled' : (data.status?.kind ?? 'ready');
  const statusMessage = !data.resolved ? (data.unknownReason ?? 'Unresolved') : (data.status?.message ?? 'Ready');
  const statusStyle = STATUS_STYLE[statusKind];

  const title = data.resolved ? (data.connectionLabel ?? data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown');
  const entityLabel = readEntityLabel(data.config);
  const writeModeLabel = data.graphNodeType === 'destination' ? readWriteMode(data.config) : undefined;

  const openMenuAt = (x: number, y: number) => {
    setContextMenu({ x, y, nodeId: id, graphNodeType: data.graphNodeType, hasConnection });
  };

  const border = isGhost
    ? 'var(--provisional-border)'
    : diffStatus
      ? '1.5px dashed var(--copilot-accent)'
      : selected
        ? '1.5px solid var(--nx-blue-panel)'
        : `1px solid ${statusStyle.border}`;

  // Running/failed top strip — 2px, absolutely positioned inside the node
  // (pointer-events: none), never a new flow element or border-top/padding
  // change, so outer node geometry is untouched. Running pulses; disabled
  // (respects prefers-reduced-motion) via the .nx-node-strip-pulse class
  // defined in theme.css. Failed has no existing header/footer slot that
  // doesn't shift the already-tight 256px layout, so per Step 5 answer #8
  // it renders strip-only (no ✕ glyph).
  const topStripColor = !isGhost && !diffStatus && statusKind === 'running'
    ? 'var(--nx-blue-panel)'
    : !isGhost && !diffStatus && statusKind === 'failed'
      ? 'var(--nx-danger)'
      : null;

  return (
    <div
      title={isGhost ? 'Proposed by Copilot — read-only until applied' : (data.ghostDiffLabel ?? undefined)}
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
        width: 256,
        minHeight: 64,
        borderRadius: 12,
        background: 'var(--nx-surface)',
        border,
        boxShadow: isGhost ? 'none' : selected ? `0 0 0 3px var(--nx-blue-tint), var(--card-shadow)` : statusStyle.shadow,
        opacity: isGhost || isDiffRemoved || statusKind === 'disabled' ? 'var(--ghost-opacity)' : 1,
        boxSizing: 'border-box',
        overflow: 'visible',
        cursor: isGhost ? 'default' : 'grab',
        userSelect: 'none',
      }}
    >
      {topStripColor && (
        <span
          aria-hidden
          className={statusKind === 'running' ? 'nx-node-strip-pulse' : undefined}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: '12px 12px 0 0',
            background: topStripColor,
            pointerEvents: 'none',
          }}
        />
      )}
      {showTargetHandle && <Port type="target" position={Position.Left} />}

      {/* Header — 64px, icon tile / role label / title / overflow menu */}
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
              flex: 'none',
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--nx-ink-3)',
              cursor: 'pointer',
              borderRadius: 6,
              fontSize: 15,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ⋯
          </button>
        )}
        {isGhost && (
          <span
            style={{
              flex: 'none',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--copilot-accent)',
              background: 'var(--nx-surface)',
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
              flex: 'none',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--copilot-accent)',
              background: 'var(--nx-surface)',
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

      {/* Body — up to 3 rows, omitted when the value doesn't exist */}
      {(data.manifestName || data.region || entityLabel || writeModeLabel) && (
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
          {entityLabel && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Table</span>
              <span style={{ fontFamily: 'var(--nx-font-mono)', color: 'var(--nx-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entityLabel}</span>
            </div>
          )}
          {writeModeLabel && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
              <span style={{ color: 'var(--nx-ink-3)' }}>Write mode</span>
              <span style={{ color: 'var(--nx-ink-2)' }}>{writeModeLabel}</span>
            </div>
          )}
        </div>
      )}

      {/* Footer — single status line, merged live from applyCheckResults */}
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
        {statusStyle.actionLabel && (
          <button
            type="button"
            className="nodrag"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSelectedNodeId(id);
            }}
            style={{ flex: 'none', border: 'none', background: 'none', color: statusStyle.text, fontWeight: 600, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
          >
            {statusStyle.actionLabel}
          </button>
        )}
      </div>

      {showSourceHandle && <Port type="source" position={Position.Right} />}
    </div>
  );
}

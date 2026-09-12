'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasNode } from '@/lib/dashboard/types';

// --c-trigger/--c-action/--c-condition/--c-data/--c-ai are the design's node
// kind colors, defined in :root in theme.css (inherited into the app shell
// scope since [data-app-theme] doesn't override them).
const KIND_COLOR: Record<CanvasNode['kind'], string> = {
  trigger: 'var(--c-trigger)',
  source: 'var(--c-data)',
  file: 'var(--c-data)',
  transform: 'var(--c-action)',
  dest: 'var(--c-ai)',
};

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;

export default function NodeCard({
  node,
  selected,
  connecting,
  onPointerDown,
  onSelect,
  onPortClick,
  onDelete,
  onDuplicate,
}: {
  node: CanvasNode;
  selected: boolean;
  connecting: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onSelect: () => void;
  onPortClick: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const color = KIND_COLOR[node.kind];

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: NODE_WIDTH,
        borderRadius: 10,
        background: 'var(--surface)',
        border: `1.5px solid ${selected || connecting ? color : 'var(--line2)'}`,
        boxShadow: selected ? `0 0 0 3px ${color}22` : '0 1px 3px rgba(15,23,42,.08)',
        cursor: 'grab',
        userSelect: 'none',
        padding: '10px 12px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: 'none' }} aria-hidden />
        <span style={{ fontSize: 12, color: 'var(--ink3)', textTransform: 'capitalize' }}>{node.kind}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            type="button"
            aria-label="Duplicate node"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            style={{ width: 18, height: 18, border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            {'\u2398'}
          </button>
          <button
            type="button"
            aria-label="Delete node"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            style={{ width: 18, height: 18, border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            {'\u2715'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', marginTop: 4 }}>{node.handle}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginTop: 2 }}>{node.tool}</div>

      {/* input port */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: -6,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 10,
          height: 10,
          borderRadius: 999,
          background: 'var(--surface)',
          border: `2px solid ${color}`,
        }}
      />
      {/* output port — click to start a wire, click a target node's output
          port again to complete it (see WorkflowCanvas.handlePortClick) */}
      <button
        type="button"
        aria-label="Connect from this node"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onPortClick();
        }}
        style={{
          position: 'absolute',
          right: -6,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 10,
          height: 10,
          padding: 0,
          borderRadius: 999,
          background: connecting ? color : 'var(--surface)',
          border: `2px solid ${color}`,
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}

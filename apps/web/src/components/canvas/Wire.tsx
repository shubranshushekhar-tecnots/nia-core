'use client';

import type { CanvasNode } from '@/lib/dashboard/types';
import { NODE_HEIGHT, NODE_WIDTH } from './NodeCard';

const KIND_COLOR: Record<CanvasNode['kind'], string> = {
  trigger: 'var(--c-trigger)',
  source: 'var(--c-data)',
  file: 'var(--c-data)',
  transform: 'var(--c-action)',
  dest: 'var(--c-ai)',
};

// Cubic-bezier wire with a fixed +-70px horizontal control-point offset,
// ported from the design's wire math. Gradient stroke between the two
// endpoint node-kind colors.
export default function Wire({
  from,
  to,
  kindFrom,
  kindTo,
  onDelete,
}: {
  from: CanvasNode;
  to: CanvasNode;
  kindFrom: CanvasNode['kind'];
  kindTo: CanvasNode['kind'];
  onDelete: () => void;
}) {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const offset = 70;
  const path = `M ${x1} ${y1} C ${x1 + offset} ${y1}, ${x2 - offset} ${y2}, ${x2} ${y2}`;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const gradientId = `wire-${from.id}-${to.id}`;

  return (
    <g>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={KIND_COLOR[kindFrom]} />
          <stop offset="100%" stopColor={KIND_COLOR[kindTo]} />
        </linearGradient>
      </defs>
      <path d={path} fill="none" stroke={`url(#${gradientId})`} strokeWidth={2} />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      />
      <circle
        cx={midX}
        cy={midY}
        r={7}
        fill="var(--surface)"
        stroke="var(--bad)"
        strokeWidth={1.5}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      />
      <text x={midX} y={midY + 3} textAnchor="middle" fontSize={9} fill="var(--bad)" style={{ pointerEvents: 'none' }}>
        {'\u2715'}
      </text>
    </g>
  );
}

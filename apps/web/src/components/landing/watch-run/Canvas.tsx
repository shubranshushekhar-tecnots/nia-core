'use client';

import { useEffect, useRef, useState } from 'react';
import NodeCard from './NodeCard';
import { EDGES, NODES, TONE_VAR, formatRows, nodeById } from './config';
import type { NodeKind, NodeStatus } from './config';

type Rect = { top: number; left: number; width: number; height: number };
type Point = { x: number; y: number };

export default function Canvas({
  statuses,
  progress,
  rowsRead,
  rowsPushed,
  followedId,
  pinnedId,
  onSelect,
}: {
  statuses: Record<NodeKind, NodeStatus>;
  progress: Record<NodeKind, number>;
  rowsRead: number;
  rowsPushed: number;
  followedId: NodeKind;
  pinnedId: NodeKind | null;
  onSelect: (id: NodeKind) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Partial<Record<NodeKind, HTMLButtonElement | null>>>({});
  const [rects, setRects] = useState<Partial<Record<NodeKind, Rect>>>({});

  useEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const next: Partial<Record<NodeKind, Rect>> = {};
      NODES.forEach((n) => {
        const el = nodeRefs.current[n.id];
        if (!el) return;
        const r = el.getBoundingClientRect();
        next[n.id] = { top: r.top - cr.top, left: r.left - cr.left, width: r.width, height: r.height };
      });
      setRects(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div ref={containerRef} className="wr-canvas">
      <svg aria-hidden="true" className="wr-canvas-svg">
        {EDGES.map((e, i) => {
          const a = rects[e.from];
          const b = rects[e.to];
          if (!a || !b) return null;

          const vertical = b.top >= a.top + a.height - 4;
          const p1: Point = vertical ? { x: a.left + a.width / 2, y: a.top + a.height } : { x: a.left + a.width, y: a.top + a.height / 2 };
          const p2: Point = vertical ? { x: b.left + b.width / 2, y: b.top } : { x: b.left, y: b.top + b.height / 2 };
          const c1: Point = vertical ? { x: p1.x, y: p1.y + (p2.y - p1.y) * 0.5 } : { x: p1.x + (p2.x - p1.x) * 0.5, y: p1.y };
          const c2: Point = vertical ? { x: p2.x, y: p2.y - (p2.y - p1.y) * 0.5 } : { x: p2.x - (p2.x - p1.x) * 0.5, y: p2.y };

          const targetStatus = statuses[e.to];
          const sourceStatus = statuses[e.from];
          const skipped = e.to === 'end' && targetStatus === 'skipped';
          const flowing = sourceStatus === 'done' && targetStatus === 'running';
          const active = flowing || (sourceStatus === 'done' && targetStatus === 'done');
          const tone = skipped ? 'var(--line-strong)' : active ? TONE_VAR[nodeById(e.to).tone] : 'var(--line)';
          const dashed = skipped || !active;
          const dot = flowing ? bezierPoint(p1, c1, c2, p2, progress[e.to] ?? 0) : null;

          return (
            <g key={i}>
              <path
                d={`M ${p1.x},${p1.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`}
                fill="none"
                stroke={tone}
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={dashed ? '7 9' : undefined}
                style={dashed && !skipped ? { animation: 'edgeFlow .7s linear infinite' } : undefined}
                opacity={skipped ? 0.55 : 1}
              />
              {dot && <circle cx={dot.x} cy={dot.y} r={4} fill={TONE_VAR[nodeById(e.to).tone]} />}
            </g>
          );
        })}
      </svg>

      <div className="wr-canvas-grid">
        {NODES.map((n) => (
          <NodeCard
            key={n.id}
            ref={(el) => {
              nodeRefs.current[n.id] = el;
            }}
            node={n}
            status={statuses[n.id]}
            progress={progress[n.id]}
            rowsLabel={n.id === 'read' ? formatRows(rowsRead) : n.id === 'push' ? formatRows(rowsPushed) : undefined}
            isFollowed={followedId === n.id}
            isPinned={pinnedId === n.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  const mt = 1 - u;
  const x = mt * mt * mt * p0.x + 3 * mt * mt * u * p1.x + 3 * mt * u * u * p2.x + u * u * u * p3.x;
  const y = mt * mt * mt * p0.y + 3 * mt * mt * u * p1.y + 3 * mt * u * u * p2.y + u * u * u * p3.y;
  return { x, y };
}

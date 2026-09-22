import type { RefObject } from 'react';
import { CANVAS_BOUNDS, COLOR, CONNECTORS, NODES, type CanvasNode } from './config';
import NodeCard from './NodeCard';
import { useConnectorCycle } from './useConnectorCycle';

// The fixed-size canvas layer (dot grid + connector paths + node cards),
// shared between the approach block's small floating window and the pin
// block's growing window — it's never scaled itself, only translated (see
// useHeroApproachProgress.ts / useHeroScrollProgress.ts), so both instances
// render pixel-identical output whenever their translate lines up.
//
// Reveal animation: both growth hooks write a `--reveal` CSS custom
// property (0→1, same easing driving the window's own size) onto the outer
// `canvasEl` div below every frame. It inherits to every descendant here,
// so node cards/connectors can fade/draw in on a per-element stagger keyed
// off it — via plain `var(--reveal, 1)` reads in `clamp()`/`calc()`, not
// React state, so this costs zero re-renders during scroll (same
// imperative-style perf pattern as the transform/size writes themselves).
// The `, 1` fallback means everything renders fully revealed before JS has
// run a frame (or under prefers-reduced-motion, where the approach hook
// never runs at all) — progressive enhancement, not a hidden-by-default gate.
//
// Run animation: independent of the above, every node/wire also carries a
// shared, always-on 7.5s CSS `linear infinite` loop (border pulse + LED
// pulse per node, a traveling "packet" dash per wire) — see the `hc-act-*`/
// `hc-led-*`/`hc-pk*` keyframes defined in HeroCanvasSection.tsx's <style>
// block. Because it's pure CSS keyframes (not JS/rAF), both this layer's
// instances (approach block's tiny chip + pin block's fullscreen canvas)
// stay frame-perfect in sync automatically — they share the same page
// timeline the instant they mount, no explicit coordination needed.
export default function HeroCanvasLayer({
  canvasRef,
  selectedId = null,
  onSelectId,
}: {
  canvasRef: RefObject<HTMLDivElement>;
  selectedId?: string | null;
  onSelectId?: (id: string) => void;
}) {
  const canvasW = CANVAS_BOUNDS.right - CANVAS_BOUNDS.left;
  const canvasH = CANVAS_BOUNDS.bottom - CANVAS_BOUNDS.top;
  const { frame: connectorFrame, fading: connectorFading } = useConnectorCycle();

  return (
    <div ref={canvasRef} style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: CANVAS_BOUNDS.left,
          top: CANVAS_BOUNDS.top,
          width: canvasW,
          height: canvasH,
          backgroundImage: `radial-gradient(circle, ${COLOR.dotGrid} 1.2px, transparent 1.2px)`,
          backgroundSize: '28px 28px',
          pointerEvents: 'none',
        }}
      />
      <svg
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: CANVAS_BOUNDS.left,
          top: CANVAS_BOUNDS.top,
          width: canvasW,
          height: canvasH,
          overflow: 'visible',
          pointerEvents: 'none',
        }}
        viewBox={`${CANVAS_BOUNDS.left} ${CANVAS_BOUNDS.top} ${canvasW} ${canvasH}`}
      >
        {CONNECTORS.map((d, i) => {
          const { from, span } = CONNECTOR_REVEAL[i] ?? { from: 0, span: 1 };
          return (
            <path
              key={d}
              d={d}
              fill="none"
              stroke={COLOR.wireBase}
              strokeWidth={1.5}
              strokeLinecap="round"
              style={{ strokeDasharray: DRAW_LEN, strokeDashoffset: drawOffset(from, span) }}
            />
          );
        })}
        {CONNECTORS.map((d, i) => (
          <path
            key={`pk-${d}`}
            d={d}
            className={`hc-pk${i + 1}`}
            stroke={COLOR.brandViolet}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
          />
        ))}
      </svg>

      {NODES.map((node) => {
        const animClass = `hc-act-${node.slot}`;
        const ledClass = `hc-led-${node.slot}`;

        // Supabase is the handoff anchor — already the focus of the rest
        // state before any growth happens — so it stays permanently visible
        // rather than fading in with the rest of the canvas. Its content is
        // swapped by useConnectorCycle (see above) to cycle through real
        // source tools; the dip-to-transparent transition below is what
        // makes that swap read as a smooth crossfade instead of a hard cut.
        if (node.id === 'supabase') {
          const cyclingNode: CanvasNode = {
            ...node,
            glyph: connectorFrame.glyph,
            title: connectorFrame.title,
            subtitle: connectorFrame.subtitle,
            color: connectorFrame.color,
          };
          return (
            <div key={node.id} style={{ transition: 'opacity 300ms ease', opacity: connectorFading ? 0 : 1 }}>
              <NodeCard
                node={cyclingNode}
                animClass={animClass}
                ledClass={ledClass}
                selected={selectedId === node.id}
                onSelect={() => onSelectId?.(node.id)}
              />
            </div>
          );
        }

        const card = (
          <NodeCard
            node={node}
            animClass={animClass}
            ledClass={ledClass}
            selected={selectedId === node.id}
            onSelect={() => onSelectId?.(node.id)}
          />
        );

        const reveal = NODE_REVEAL[node.id];
        if (!reveal) return <div key={node.id}>{card}</div>;
        return (
          <div key={node.id} style={{ opacity: revealOpacity(reveal.from, reveal.span) }}>
            {card}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reveal stagger
// ---------------------------------------------------------------------------

// Each entry ramps that node's opacity 0→1 as `--reveal` crosses
// [from, from + span]. Ordered outward from the Supabase anchor node so the
// canvas reads as "building out" while the window grows, instead of every
// node/connector snapping into view the instant the clip rect reaches it.
const NODE_REVEAL: Partial<Record<(typeof NODES)[number]['id'], { from: number; span: number }>> = {
  schedule: { from: 0.04, span: 0.22 },
  claude: { from: 0.04, span: 0.22 },
  route: { from: 0.24, span: 0.26 },
  powerbi: { from: 0.38, span: 0.26 },
  slack: { from: 0.52, span: 0.28 },
};

// Parallel to CONNECTORS — each path's reveal keys off whichever endpoint
// (schedule/supabase/claude/route/powerbi/slack) appears later, so a line
// never visibly finishes drawing before both nodes it connects have shown up.
const CONNECTOR_REVEAL: { from: number; span: number }[] = [
  { from: 0.04, span: 0.22 }, // schedule -> supabase
  { from: 0.04, span: 0.22 }, // supabase -> claude
  { from: 0.24, span: 0.26 }, // claude -> route
  { from: 0.38, span: 0.26 }, // route -> powerbi
  { from: 0.52, span: 0.28 }, // route -> slack
];

function revealOpacity(from: number, span: number): string {
  return `clamp(0, calc((var(--reveal, 1) - ${from}) * ${(1 / span).toFixed(3)}), 1)`;
}

// Larger than any connector path's actual length (longest is the elbowed
// claude->route return path, well under 1000 canvas px) — the standard
// SVG "draw the line" technique: a dasharray at least this long only ever
// shows a single dash, so animating its offset from DRAW_LEN (nothing
// visible) to 0 (fully visible) draws the path start-to-end without needing
// each path's exact length.
const DRAW_LEN = 1200;

function drawOffset(from: number, span: number): string {
  return `clamp(0, calc(${DRAW_LEN} - (var(--reveal, 1) - ${from}) * ${(DRAW_LEN / span).toFixed(1)}), ${DRAW_LEN})`;
}

import type { RefObject } from 'react';
import { CANVAS_BOUNDS, COLOR, CONNECTORS, NODES } from './config';
import NodeCard from './NodeCard';

// The fixed-size canvas layer (dot grid + connector paths + node cards),
// shared between the approach block's small floating window and the pin
// block's growing window — it's never scaled itself, only translated (see
// useHeroApproachProgress.ts / useHeroScrollProgress.ts), so both instances
// render pixel-identical output whenever their translate lines up.
export default function HeroCanvasLayer({ canvasRef }: { canvasRef: RefObject<HTMLDivElement> }) {
  const canvasW = CANVAS_BOUNDS.right - CANVAS_BOUNDS.left;
  const canvasH = CANVAS_BOUNDS.bottom - CANVAS_BOUNDS.top;

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
        {CONNECTORS.map((d) => (
          <path key={d} d={d} fill="none" stroke={COLOR.connector} strokeWidth={1.5} strokeLinecap="round" />
        ))}
      </svg>

      {NODES.map((node) => (
        <NodeCard key={node.id} node={node} />
      ))}
    </div>
  );
}

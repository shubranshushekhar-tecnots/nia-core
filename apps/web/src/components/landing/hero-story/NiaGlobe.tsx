'use client';

import { useEffect, useRef } from 'react';
import { cssVar } from './cssVar';
import { startNiaGlobe } from './nia-globe.js';

// Rotating data-center globe painted behind the hero. First child of
// #nx-stage (zIndex 0) so it sits behind the S1 data-hall layer (zIndex 1,
// ExtractScene) and the hero text (zIndex 8, HeroHeadline) — the headline's
// node window still reveals the data hall on scroll. Fades with the hero via
// --c0/--v-globe (see useNiaHeroEngine.ts). Do not rewrite or simplify
// nia-globe.js — it's a verbatim drop-in from designs/globe-addon.
export default function NiaGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const stop = startNiaGlobe(canvas);
    return stop;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="nx-globe"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        zIndex: 0,
        opacity: 'var(--c0, 1)',
        visibility: cssVar<'visibility'>('var(--v-globe, visible)'),
        touchAction: 'pan-y',
        cursor: 'default',
      }}
    />
  );
}

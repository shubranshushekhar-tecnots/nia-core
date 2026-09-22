'use client';

import { useEffect, type RefObject } from 'react';
import { HANDOFF_WINDOW, PRIMARY_NODE_CENTER, REST_WINDOW } from './config';
import { clamp01, heroEase, lerp } from './bezier';

export type HeroApproachRefs = {
  blockEl: RefObject<HTMLDivElement>; // the approach block itself (normal flow, not sticky)
  windowEl: RefObject<HTMLDivElement>; // small fixed-position window floating toward center
  canvasEl: RefObject<HTMLDivElement>; // canvas layer inside the window (translate only)
  ghostEl: RefObject<HTMLSpanElement>; // invisible in-flow placeholder the window rests against
};

// Drives the approach block: real (non-pinned) scroll, so the headline just
// scrolls away with the page while this hook moves the small preview
// window — via `position: fixed`, independent of the normally-scrolling
// text underneath it — from its rest position (next to the ghost span) to
// dead-center of the viewport, growing its native crop size from
// REST_WINDOW up to HANDOFF_WINDOW along the way (the pin block then
// continues that same growth from HANDOFF_WINDOW to fullscreen — see
// useHeroScrollProgress). Growing here too, instead of only once the pin
// block takes over, means nodes/connectors are already filling the frame
// well before the headline has fully scrolled away, instead of leaving a
// long stretch of near-empty black ground with just a small floating chip
// in it. Progress is purely local to this block's own bounding rect, so it
// naturally reaches 1 exactly when the block scrolls fully past the top of
// the viewport — i.e. exactly when the pin block (immediately following in
// the DOM) starts sticking.
export function useHeroApproachProgress(refs: HeroApproachRefs) {
  useEffect(() => {
    const blockEl = refs.blockEl.current;
    const windowEl = refs.windowEl.current;
    const canvasEl = refs.canvasEl.current;
    const ghostEl = refs.ghostEl.current;
    if (!blockEl || !windowEl || !canvasEl) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MOBILE_BREAKPOINT = 768;
    if (reduce || window.innerWidth < MOBILE_BREAKPOINT) return undefined;

    let restBox = { top: 0, left: 0, width: REST_WINDOW.w, height: REST_WINDOW.h };

    const measure = () => {
      if (!ghostEl) return;
      const g = ghostEl.getBoundingClientRect();
      if (g.width > 0 && g.height > 0) {
        restBox = { top: g.top, left: g.left, width: g.width, height: g.height };
      }
    };

    const applyFrame = () => {
      if (window.innerWidth < MOBILE_BREAKPOINT) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = blockEl.getBoundingClientRect();
      const raw = clamp01(-rect.top / rect.height);
      const eased = heroEase(raw);

      // restScale bridges REST_WINDOW's native (crop) size down to its
      // small displayed rest footprint (the ghost span's measured size) —
      // still only relevant at raw=0; by raw=1 the window is at
      // HANDOFF_WINDOW's native size with no extra scale-down, exactly
      // matching the pin block's starting frame.
      const restScale = restBox.width / REST_WINDOW.w;
      const restCx = restBox.left + restBox.width / 2;
      const restCy = restBox.top + restBox.height / 2;
      const cx = lerp(restCx, vw / 2, eased);
      const cy = lerp(restCy, vh / 2, eased);

      const w = lerp(REST_WINDOW.w, HANDOFF_WINDOW.w, eased);
      const h = lerp(REST_WINDOW.h, HANDOFF_WINDOW.h, eased);
      const scale = lerp(restScale, 1, eased);

      windowEl.style.width = `${w}px`;
      windowEl.style.height = `${h}px`;
      windowEl.style.left = `${cx - w / 2}px`;
      windowEl.style.top = `${cy - h / 2}px`;
      windowEl.style.transform = `scale(${scale.toFixed(4)})`;
      // Hide the window until it's actually reached (or is about to reach)
      // the block, and fully hide it once the pin block has taken over —
      // avoids a stray floating card if this block is scrolled past very
      // fast or the ghost hasn't been measured yet.
      windowEl.style.opacity = raw >= 1 ? '0' : '1';
      windowEl.style.pointerEvents = 'none';

      const canvasTx = w / 2 - PRIMARY_NODE_CENTER.x;
      const canvasTy = h / 2 - PRIMARY_NODE_CENTER.y;
      canvasEl.style.transform = `translate3d(${canvasTx}px, ${canvasTy}px, 0)`;

      // Drives HeroCanvasLayer's staggered node/connector reveal (see its
      // `--reveal`-based CSS there) — same `eased` value already driving the
      // window's own growth, so neighboring nodes/connectors build in as the
      // window opens rather than popping in fully formed.
      canvasEl.style.setProperty('--reveal', eased.toFixed(3));
    };

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyFrame();
      });
    };

    measure();
    applyFrame();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

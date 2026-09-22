'use client';

import { useEffect, type RefObject } from 'react';
import { PRIMARY_NODE_CENTER, REST_WINDOW } from './config';
import { clamp01, heroEase, lerp } from './bezier';

export type HeroApproachRefs = {
  blockEl: RefObject<HTMLDivElement>; // the approach block itself (normal flow, not sticky)
  windowEl: RefObject<HTMLDivElement>; // small fixed-position window floating toward center
  canvasEl: RefObject<HTMLDivElement>; // canvas layer inside the window (translate only)
  ghostEl: RefObject<HTMLSpanElement>; // invisible in-flow placeholder the window rests against
};

// Drives the approach block: real (non-pinned) scroll, so the headline just
// scrolls away with the page while this hook only moves the small preview
// window — via `position: fixed`, independent of the normally-scrolling
// text underneath it — from its rest position (next to the ghost span) to
// dead-center of the viewport. Size never changes here (that only happens
// once the pin block takes over). Progress is purely local to this block's
// own bounding rect, so it naturally reaches 1 exactly when the block
// scrolls fully past the top of the viewport — i.e. exactly when the pin
// block (immediately following in the DOM) starts sticking.
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

    const canvasTx = REST_WINDOW.w / 2 - PRIMARY_NODE_CENTER.x;
    const canvasTy = REST_WINDOW.h / 2 - PRIMARY_NODE_CENTER.y;
    canvasEl.style.transform = `translate3d(${canvasTx}px, ${canvasTy}px, 0)`;

    const applyFrame = () => {
      if (window.innerWidth < MOBILE_BREAKPOINT) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = blockEl.getBoundingClientRect();
      const raw = clamp01(-rect.top / rect.height);
      const eased = heroEase(raw);

      const restScale = restBox.width / REST_WINDOW.w;
      const restCx = restBox.left + restBox.width / 2;
      const restCy = restBox.top + restBox.height / 2;
      const cx = lerp(restCx, vw / 2, eased);
      const cy = lerp(restCy, vh / 2, eased);

      windowEl.style.width = `${REST_WINDOW.w}px`;
      windowEl.style.height = `${REST_WINDOW.h}px`;
      windowEl.style.left = `${cx - REST_WINDOW.w / 2}px`;
      windowEl.style.top = `${cy - REST_WINDOW.h / 2}px`;
      windowEl.style.transform = `scale(${restScale.toFixed(4)})`;
      // Hide the window until it's actually reached (or is about to reach)
      // the block, and fully hide it once the pin block has taken over —
      // avoids a stray floating card if this block is scrolled past very
      // fast or the ghost hasn't been measured yet.
      windowEl.style.opacity = raw >= 1 ? '0' : '1';
      windowEl.style.pointerEvents = 'none';
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

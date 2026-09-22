'use client';

import { useEffect, type RefObject } from 'react';
import { PRIMARY_NODE_CENTER, PIN_THRESHOLD, REST_WINDOW } from './config';
import { clamp01, heroEase, lerp, smoothstep } from './bezier';

export type HeroRefs = {
  wrapper: RefObject<HTMLElement>; // tall spacer section (~420vh)
  windowEl: RefObject<HTMLDivElement>; // the clipping window
  canvasEl: RefObject<HTMLDivElement>; // fixed-size, never transformed except translate
  textEl: RefObject<HTMLDivElement>; // h1 + sub + CTAs + bottom-left/right chrome (rest state)
  ghostEl: RefObject<HTMLSpanElement>; // invisible in-flow placeholder the window aligns to at rest
  chromeEl: RefObject<HTMLDivElement>; // full-bleed overlay chrome (reel/checks/rows/rail)
  railFillEl: RefObject<HTMLDivElement>; // progress rail fill
};

// Single passive scroll listener → rAF → CSS custom properties. No layout
// reads inside the rAF callback itself (bounding rects are only read once
// per scroll event, not per animation frame) and no state, so React never
// re-renders on scroll — only style props get mutated directly.
export function useHeroScrollProgress(refs: HeroRefs) {
  useEffect(() => {
    const wrapper = refs.wrapper.current;
    const windowEl = refs.windowEl.current;
    const canvasEl = refs.canvasEl.current;
    const textEl = refs.textEl.current;
    const ghostEl = refs.ghostEl.current;
    const chromeEl = refs.chromeEl.current;
    const railFillEl = refs.railFillEl.current;
    if (!wrapper || !windowEl || !canvasEl) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const MOBILE_BREAKPOINT = 768;

    // Rest box, measured live from the ghost span (falls back to the
    // REST_WINDOW constants only if the ghost can't be measured yet).
    // Re-measured on resize alongside `range`. This is the *displayed*
    // (post-scale) box — the ghost is now sized smaller than the window's
    // native crop (REST_WINDOW), so `restScale` (displayed / native width)
    // drives a CSS transform that shrinks the window for display without
    // changing what's cropped. Position (top/left) still eases from the
    // ghost's natural (left-aligned) line position to viewport-center as
    // the hero opens — it doesn't need to be centered at rest.
    let restBox = { top: 0, left: 0, width: REST_WINDOW.w, height: REST_WINDOW.h };
    let restScale = 1;

    const applyFrame = (raw: number) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isMobile = vw < MOBILE_BREAKPOINT;

      let w: number;
      let h: number;

      if (isMobile) {
        // Below 768px the window is a static, full-width band laid out
        // entirely by CSS (see HeroCanvasSection's media query) — no
        // sticky pin, no settle, no scroll-scrubbed growth. We only read
        // its rendered size back so the canvas translate can still centre
        // Supabase inside it (still never scaling the card itself).
        windowEl.style.width = '';
        windowEl.style.height = '';
        windowEl.style.left = '';
        windowEl.style.top = '';
        windowEl.style.transform = '';
        const rect = windowEl.getBoundingClientRect();
        w = rect.width;
        h = rect.height;
      } else {
        // Phase A (raw 0 -> PIN_THRESHOLD): the window only moves — it
        // slides from its rest position to dead-center of the viewport on
        // both axes while staying at rest size. Phase B (PIN_THRESHOLD ->
        // 1): the window only grows — cx/cy are already pinned at vw/2,
        // vh/2 by the end of Phase A, so it expands evenly in all four
        // directions instead of growing and repositioning at once (which
        // read as a diagonal drift/zoom happening too early).
        const posT = clamp01(raw / PIN_THRESHOLD);
        const posEased = heroEase(posT);
        const sizeT = clamp01((raw - PIN_THRESHOLD) / (1 - PIN_THRESHOLD));
        const sizeEased = heroEase(sizeT);
        // w/h grow from the window's native crop size (REST_WINDOW), not
        // the (now smaller, scaled-down) displayed ghost box — the crop
        // itself doesn't change, only how large it renders at rest. A
        // `scale()` transform bridges native → displayed size, eased on
        // the same curve so it lands exactly at 1 (no crop-vs-render size
        // mismatch) by the time w/h finish growing to vw/vh.
        w = lerp(REST_WINDOW.w, vw, sizeEased);
        h = lerp(REST_WINDOW.h, vh, sizeEased);
        const scale = lerp(restScale, 1, sizeEased);
        const restCx = restBox.left + restBox.width / 2;
        const restCy = restBox.top + restBox.height / 2;
        const cx = lerp(restCx, vw / 2, posEased);
        const cy = lerp(restCy, vh / 2, posEased);
        windowEl.style.width = `${w}px`;
        windowEl.style.height = `${h}px`;
        windowEl.style.left = `${cx - w / 2}px`;
        windowEl.style.top = `${cy - h / 2}px`;
        windowEl.style.transform = `scale(${scale.toFixed(4)})`;
      }

      const canvasTx = w / 2 - PRIMARY_NODE_CENTER.x;
      const canvasTy = h / 2 - PRIMARY_NODE_CENTER.y;
      canvasEl.style.transform = `translate3d(${canvasTx}px, ${canvasTy}px, 0)`;

      if (isMobile) return;

      const posT = clamp01(raw / PIN_THRESHOLD);
      const posEased = heroEase(posT);
      const pinned = raw >= PIN_THRESHOLD;

      if (textEl) {
        // opacity only (never `visibility`/`display`) so the h1 stays in
        // the accessibility tree and reading order at every scroll
        // position — `pointer-events` alone is enough to stop the faded
        // text hit-testing over the canvas once pinned.
        const textOpacity = 1 - posEased;
        textEl.style.opacity = textOpacity.toFixed(3);
        textEl.style.transform = `translateY(${(-40 * posEased).toFixed(1)}px)`;
        textEl.style.pointerEvents = pinned ? 'none' : 'auto';
      }

      if (chromeEl) {
        const chromeOpacity = smoothstep(PIN_THRESHOLD, 0.5, raw);
        chromeEl.style.opacity = chromeOpacity.toFixed(3);
        chromeEl.style.pointerEvents = chromeOpacity < 0.5 ? 'none' : 'auto';
      }

      if (railFillEl) {
        railFillEl.style.width = `${(raw * 100).toFixed(2)}%`;
      }

      wrapper.dataset.heroPinned = pinned ? 'true' : 'false';
    };

    if (reduce) {
      // Static full-bleed final state: no settle, no open, no listener.
      applyFrame(1);
      return undefined;
    }

    let raf = 0;
    let range = 1;

    const measure = () => {
      const rect = wrapper.getBoundingClientRect();
      range = Math.max(1, rect.height - window.innerHeight);
      if (ghostEl) {
        const g = ghostEl.getBoundingClientRect();
        if (g.width > 0 && g.height > 0) {
          restBox = { top: g.top, left: g.left, width: g.width, height: g.height };
          restScale = g.width / REST_WINDOW.w;
        }
      }
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = wrapper.getBoundingClientRect();
        const raw = clamp01(-rect.top / range);
        applyFrame(raw);
      });
    };

    measure();
    applyFrame(0);
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

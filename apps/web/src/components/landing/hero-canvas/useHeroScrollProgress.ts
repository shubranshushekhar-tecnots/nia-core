'use client';

import { useEffect, type RefObject } from 'react';
import { PRIMARY_NODE_CENTER, REST_WINDOW } from './config';
import { clamp01, heroEase, lerp, smoothstep } from './bezier';

export type HeroPinRefs = {
  heroEl: RefObject<HTMLElement>; // outer hero section (both blocks) — carries the heroPinned flag Nav reads
  pinWrapperEl: RefObject<HTMLDivElement>; // this block's own tall spacer (~300vh)
  windowEl: RefObject<HTMLDivElement>; // the clipping window — already centered, only grows
  canvasEl: RefObject<HTMLDivElement>; // fixed-size, never transformed except translate
  ghostEl: RefObject<HTMLSpanElement>; // approach block's ghost span — only used to read restScale
  chromeEl: RefObject<HTMLDivElement>; // full-bleed overlay chrome (reel/checks/rows/rail)
  railFillEl: RefObject<HTMLDivElement>; // progress rail fill
};

// Drives the pin block: this is the scroll-jacked part — the window starts
// already centered (approach block handed it off there) and only grows,
// from its small rest-display size up to fullscreen, while chrome fades in.
// No text/position easing here anymore (that's the approach block's job).
export function useHeroScrollProgress(refs: HeroPinRefs) {
  useEffect(() => {
    const heroEl = refs.heroEl.current;
    const pinWrapperEl = refs.pinWrapperEl.current;
    const windowEl = refs.windowEl.current;
    const canvasEl = refs.canvasEl.current;
    const ghostEl = refs.ghostEl.current;
    const chromeEl = refs.chromeEl.current;
    const railFillEl = refs.railFillEl.current;
    if (!heroEl || !pinWrapperEl || !windowEl || !canvasEl) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MOBILE_BREAKPOINT = 768;

    // Displayed (post-scale) rest size, read from the approach block's
    // ghost span — falls back to REST_WINDOW's native size (scale 1) if it
    // can't be measured yet. Re-measured on resize alongside `range`.
    let restScale = 1;

    const applyFrame = (raw: number, stuck: boolean) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isMobile = vw < MOBILE_BREAKPOINT;

      // Sticky elements still render at their normal in-flow position
      // *before* they've actually stuck (i.e. while scrolled near but not
      // yet at the top of the viewport) — without this, the pin block's
      // card would peek into view from the bottom of the screen while the
      // approach block's own floating card is still mid-transit, showing
      // two cards at once. Keep it fully hidden until the handoff instant
      // (exactly when the approach block's card reaches raw=1 and fades
      // out), then reveal it.
      if (!isMobile) {
        windowEl.style.opacity = stuck ? '1' : '0';
      }

      let w: number;
      let h: number;

      if (isMobile) {
        // Below 768px the window is a static, full-width band laid out
        // entirely by CSS (see HeroCanvasSection's media query) — no
        // sticky pin, no scroll-scrubbed growth. We only read its rendered
        // size back so the canvas translate can still centre Supabase
        // inside it (still never scaling the card itself).
        windowEl.style.width = '';
        windowEl.style.height = '';
        windowEl.style.left = '';
        windowEl.style.top = '';
        windowEl.style.transform = '';
        const rect = windowEl.getBoundingClientRect();
        w = rect.width;
        h = rect.height;
      } else {
        const sizeEased = heroEase(raw);
        // w/h grow from the window's native crop size (REST_WINDOW), not
        // the (smaller, scaled-down) displayed rest size — the crop itself
        // doesn't change, only how large it renders. A `scale()` transform
        // bridges native → displayed size, eased on the same curve so it
        // lands exactly at 1 (no crop-vs-render size mismatch) by the time
        // w/h finish growing to vw/vh. Position is constant — already
        // centered by the time the approach block handed off here.
        w = lerp(REST_WINDOW.w, vw, sizeEased);
        h = lerp(REST_WINDOW.h, vh, sizeEased);
        const scale = lerp(restScale, 1, sizeEased);
        windowEl.style.width = `${w}px`;
        windowEl.style.height = `${h}px`;
        windowEl.style.left = `${vw / 2 - w / 2}px`;
        windowEl.style.top = `${vh / 2 - h / 2}px`;
        windowEl.style.transform = `scale(${scale.toFixed(4)})`;
      }

      const canvasTx = w / 2 - PRIMARY_NODE_CENTER.x;
      const canvasTy = h / 2 - PRIMARY_NODE_CENTER.y;
      canvasEl.style.transform = `translate3d(${canvasTx}px, ${canvasTy}px, 0)`;

      if (isMobile) return;

      if (chromeEl) {
        const chromeOpacity = smoothstep(0, 0.3, raw);
        chromeEl.style.opacity = chromeOpacity.toFixed(3);
        chromeEl.style.pointerEvents = chromeOpacity < 0.5 ? 'none' : 'auto';
      }

      if (railFillEl) {
        railFillEl.style.width = `${(raw * 100).toFixed(2)}%`;
      }
    };

    if (reduce) {
      // Static full-bleed final state: no settle, no open, no listener.
      applyFrame(1, true);
      heroEl.dataset.heroPinned = 'true';
      return undefined;
    }

    let raf = 0;
    let range = 1;

    const measure = () => {
      const rect = pinWrapperEl.getBoundingClientRect();
      range = Math.max(1, rect.height - window.innerHeight);
      if (ghostEl) {
        const g = ghostEl.getBoundingClientRect();
        if (g.width > 0 && g.height > 0) {
          restScale = g.width / REST_WINDOW.w;
        }
      }
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = pinWrapperEl.getBoundingClientRect();
        const raw = clamp01(-rect.top / range);
        const stuck = rect.top <= 0;
        applyFrame(raw, stuck);
        heroEl.dataset.heroPinned = stuck ? 'true' : 'false';
      });
    };

    measure();
    applyFrame(0, (pinWrapperEl.getBoundingClientRect().top ?? 1) <= 0);
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

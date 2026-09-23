'use client';

import { useEffect, type RefObject } from 'react';
import { HANDOFF_WINDOW, PRIMARY_NODE_CENTER } from './config';
import { clamp01, heroEase, lerp, smoothstep } from './bezier';

export type HeroPinRefs = {
  heroEl: RefObject<HTMLElement>; // outer hero section (both blocks) — carries the heroPinned flag Nav reads
  pinWrapperEl: RefObject<HTMLDivElement>; // this block's own tall spacer (~300vh)
  windowEl: RefObject<HTMLDivElement>; // the clipping window — already centered, only grows
  canvasEl: RefObject<HTMLDivElement>; // fixed-size, never transformed except translate
  chromeEl: RefObject<HTMLDivElement>; // full-bleed overlay chrome (reel/checks/rows/rail)
  railFillEl: RefObject<HTMLDivElement>; // progress rail fill
};

// Drives the pin block: this is the scroll-jacked part — the window starts
// already centered at HANDOFF_WINDOW's size (the approach block grew it to
// exactly that size and handed it off there) and only grows further, up to
// fullscreen, while chrome fades in. No text/position easing here anymore
// (that's the approach block's job).
export function useHeroScrollProgress(refs: HeroPinRefs) {
  useEffect(() => {
    const heroEl = refs.heroEl.current;
    const pinWrapperEl = refs.pinWrapperEl.current;
    const windowEl = refs.windowEl.current;
    const canvasEl = refs.canvasEl.current;
    const chromeEl = refs.chromeEl.current;
    const railFillEl = refs.railFillEl.current;
    if (!heroEl || !pinWrapperEl || !windowEl || !canvasEl) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MOBILE_BREAKPOINT = 768;

    const applyFrame = (raw: number, stuck: boolean) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isMobile = vw < MOBILE_BREAKPOINT;
      // Hoisted so both the desktop (size growth) and mobile (reveal-only)
      // branches below can use it — see HeroCanvasLayer's `--reveal`-driven
      // node/connector stagger, which this continues from where the
      // approach block's own `eased` left off.
      const sizeEased = heroEase(raw);

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
        // w/h grow from the size the approach block already grew the
        // window to (HANDOFF_WINDOW) up to fullscreen. No extra `scale()`
        // bridging needed here (unlike the approach block) — by the time
        // this block takes over, the window is already at its true native
        // size, no display-vs-crop mismatch to correct for. Position is
        // constant — already centered by the time the approach block
        // handed off here.
        w = lerp(HANDOFF_WINDOW.w, vw, sizeEased);
        h = lerp(HANDOFF_WINDOW.h, vh, sizeEased);
        windowEl.style.width = `${w}px`;
        windowEl.style.height = `${h}px`;
        windowEl.style.left = `${vw / 2 - w / 2}px`;
        windowEl.style.top = `${vh / 2 - h / 2}px`;
        windowEl.style.transform = '';
      }

      const canvasTx = w / 2 - PRIMARY_NODE_CENTER.x;
      const canvasTy = h / 2 - PRIMARY_NODE_CENTER.y;
      canvasEl.style.transform = `translate3d(${canvasTx}px, ${canvasTy}px, 0)`;

      // Always fully revealed here — this is a *separate* DOM instance from
      // the approach block's canvas (each block renders its own
      // HeroCanvasLayer), so by the time this block takes over at the
      // handoff instant, the approach block's own `--reveal` has already
      // finished (see useHeroApproachProgress). Driving this instance's
      // `--reveal` off this block's own `raw`/`sizeEased` instead — which
      // restarts at 0 — would snap already-revealed nodes back to faint
      // for a moment right at the handoff, a visible regression flash.
      canvasEl.style.setProperty('--reveal', '1');

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

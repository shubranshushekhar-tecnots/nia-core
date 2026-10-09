'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useLenis } from 'lenis/react';

export type NiaHeroEngineRefs = {
  trackRef: RefObject<HTMLDivElement>;
  stageRef: RefObject<HTMLDivElement>;
  windowRef: RefObject<HTMLSpanElement>;
};

export const CHAPTER_NAMES = ['Extract', 'Transform', 'Move', 'Load'] as const;
const STATUS_BY_CHAPTER = ['Ready', 'Extracting', 'Transforming', 'Moving · encrypted', 'Loaded · any destination'];

type Billing = 'm' | 'a';
type ConnectorTab = 's' | 'd';

// Direct, byte-faithful port of designs/nia-hero/index.html's NiaHero.apply(p, stage)
// (reference lines 630-752). Every constant/formula below is load-bearing for the
// choreography/timing of the scroll story — do not "clean up" or approximate them.
// Like the reference, and like this repo's existing
// hero-canvas/useHeroScrollProgress.ts pattern, this writes CSS custom properties
// straight onto document.documentElement every frame instead of driving React
// state, so there is no per-frame re-render.
function apply(p: number, stage: HTMLDivElement, windowEl: HTMLSpanElement | null) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const S = (a: number, b: number) => {
    const t = clamp((p - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const L = (a: number, b: number) => clamp((p - a) / (b - a));
  const W = (a: number, b: number) => S(a, a + 0.022) * (1 - S(b - 0.022, b));
  const vis = (o: number) => (o > 0.002 ? 'visible' : 'hidden');
  const f = (n: number, d = 4) => n.toFixed(d);
  const root = document.documentElement;

  const sr = stage.getBoundingClientRect();
  const w = sr.width;
  const h = sr.height;
  const cover = Math.max(w / 1672, h / 882);
  const coverDest = Math.max(w / 1672, h / 934);
  const coverD = Math.max(w, h) / 1254;
  const vs = w <= 820 ? Math.min(h / 900, w / 760) : Math.min(h / 900, w / 1180);

  // 0 · hero: the node window in the headline opens onto the data center
  const c0 = 1 - S(0.006, 0.032);
  root.style.setProperty('--win-o', f(1 - S(0.002, 0.012)));
  root.style.setProperty('--hero-y', `${f(-(1 - c0) * 40, 1)}px`);
  const k = S(0.004, 0.075);
  let clip = 'inset(0px 0px 0px 0px)';
  let pre = 'none';
  if (windowEl && k < 1) {
    const wr = windowEl.getBoundingClientRect();
    const t = (wr.top - sr.top) * (1 - k);
    const l = (wr.left - sr.left) * (1 - k);
    const rt = (sr.right - wr.right) * (1 - k);
    const b = (sr.bottom - wr.bottom) * (1 - k);
    clip = `inset(${f(t, 1)}px ${f(rt, 1)}px ${f(b, 1)}px ${f(l, 1)}px)`;
    const dx = (wr.left + wr.width / 2 - sr.left - w / 2) * (1 - k);
    const dy0 = (wr.top + wr.height / 2 - sr.top - h / 2) * (1 - k);
    const z0 = Math.max(wr.width / w, wr.height / h);
    const z = z0 + (1 - z0) * k;
    pre = `translate(${f(dx, 1)}px,${f(dy0, 1)}px) scale(${f(z)})`;
  }

  // 1 · dolly down the aisle, into the rack, match-cut to the drive, into the light
  const d = S(0.075, 0.17);
  const t = 8.93 * d;
  const sRoom = 10 / (10 - t);
  const sRacks = 5.5 / Math.max(0.6, 5.5 - t);
  const sHero = ((0.0977 * 9.5) / (9.5 - t)) * (1 + 2.4 * S(0.168, 0.196));
  const flashA = 0;
  const heroBlur = 10 * S(0.178, 0.198);
  const bayBlur = 12 * (1 - S(0.184, 0.208));
  const bayS = (w / 2172) * 1.08 * (1 + 3.4 * S(0.192, 0.245));
  const bz = S(0.192, 0.245);
  const bcx = 1086 + (1157 - 1086) * bz;
  const bcy = 369 + (236 - 369) * bz;
  const tBay = `translate(${f(-bayS * bcx, 1)}px,${f(-bayS * bcy, 1)}px) scale(${f(bayS)})`;
  const oRacks = 1 - clamp((t - 3.4) / 1.4);
  const roomBlur = Math.min(5, (sRoom - 1) * 0.9);
  const racksBlur = Math.min(8, (sRacks - 1) * 1.4);
  const b1 = 0.6 * S(0.17, 0.186) * (1 - S(0.194, 0.214));
  const bloom1S = 0.5 + 1.2 * S(0.17, 0.21);
  const oDrive = S(0.178, 0.2);
  const sDrive = coverD;
  const bloomS = 0.35 + S(0.212, 0.245) * 3.2;
  const bloomO = S(0.214, 0.236) * (1 - S(0.25, 0.285));
  const flash = 0;
  const v1 = p < 0.255;

  // 2 · transform: follow the pulse along the fibre
  const oWire = S(0.224, 0.252) * (1 - S(0.6, 0.62));
  const s = L(0.255, 0.52) * 3200;
  const g0 = clamp(1 - Math.abs(700 - s) / 450);
  const g1 = clamp(1 - Math.abs(1700 - s) / 450);
  const g2 = clamp(1 - Math.abs(2600 - s) / 450);

  // 3 · move: waterline rises over the fibre, later drops away
  const dive = S(0.5, 0.56);
  const rise = S(0.77, 0.835);
  const seaTop = clamp(1 - dive + rise) * 100;
  const seaMove = L(0.53, 0.79);
  const lens = W(0.585, 0.672);
  const gauge = W(0.672, 0.77);

  // 4 · load
  const sDest = coverDest * (1.3 - 0.3 * S(0.775, 0.875));
  const dbglow = S(0.855, 0.88);
  const rowin = S(0.928, 0.948);
  const orbit = S(0.93, 0.97);
  const oDest = S(0.765, 0.78);

  // 5 · canvas, closing on black
  const fin = 0;
  const ui = 0;

  // the row
  const dot = S(0.235, 0.26) * (1 - dbglow);

  // nav + journey bar
  // Byte-faithful port of the reference's navLight: goes light ~2.5%-6% into
  // the scroll (i.e. just past the black hero, into the first light scene)
  // and stays light the rest of the way.
  const navLight = S(0.025, 0.06) * (1 - fin);
  const navEl = document.querySelector<HTMLElement>('.nia-nav');
  if (navEl) {
    const navTheme = navLight > 0.5 ? 'light' : 'dark';
    if (navEl.dataset.theme !== navTheme) navEl.dataset.theme = navTheme;
  }
  const hud = S(0.06, 0.09) * (1 - fin);

  // copy — stage words: wipe in left→right, hold, fade up and out
  const weIn = S(0.064, 0.086);
  const weO = S(0.064, 0.073) * (1 - S(0.104, 0.12));
  const wtIn = S(0.245, 0.268);
  const wtO = S(0.245, 0.255) * (1 - S(0.286, 0.302));
  const wlIn = S(0.84, 0.865);
  const wlO = S(0.84, 0.85) * (1 - S(0.912, 0.93));
  const c = [c0, W(0.112, 0.17), W(0.298, 0.35), W(0.355, 0.44), W(0.44, 0.505), W(0.565, 0.775), S(0.928, 0.948), 0];

  const v: Record<string, string> = {
    '--p': f(p),
    '--cover': f(cover),
    '--vs': f(vs),
    '--s1-clip': clip,
    '--s1-pre': pre,
    '--s-room': f(sRoom),
    '--s-racks': f(sRacks),
    '--s-hero': f(sHero),
    '--o-racks': f(oRacks),
    '--room-blur': `${f(roomBlur, 2)}px`,
    '--racks-blur': `${f(racksBlur, 2)}px`,
    '--bloom1-o': f(b1),
    '--bloom1-s': f(bloom1S),
    '--v1': v1 ? 'visible' : 'hidden',
    '--o-drive': f(oDrive),
    '--s-drive': f(sDrive),
    '--t-bay': tBay,
    '--flash-a': f(flashA),
    '--hero-blur': `${f(heroBlur, 2)}px`,
    '--bay-blur': `${f(bayBlur, 2)}px`,
    '--v-drive': v1 && oDrive > 0.002 ? 'visible' : 'hidden',
    '--bloom-s': f(bloomS),
    '--bloom-o': f(bloomO),
    '--flash': f(flash),
    '--o-wire': f(oWire),
    '--v-wire': vis(oWire),
    '--t-wire': `translateX(${f(-s, 1)}px)`,
    '--wire-x': `${f(-s, 1)}px`,
    '--wire-bg': `${f(-s * 0.35, 1)}px`,
    '--g0': f(g0),
    '--g1': f(g1),
    '--g2': f(g2),
    '--sea-top': `${f(seaTop, 3)}%`,
    '--v-sea': seaTop < 99.9 ? 'visible' : 'hidden',
    '--v-wave': seaTop > 0.1 && seaTop < 99.9 ? 'visible' : 'hidden',
    '--sea-x': `${f(-seaMove * 2200, 1)}px`,
    '--seab-x': `${f(-seaMove * 2200, 1)}px`,
    '--lens': f(lens),
    '--gauge': f(gauge),
    '--o-dest': f(oDest),
    '--v-dest': vis(oDest),
    '--s-dest': f(sDest),
    '--dbglow': f(dbglow),
    '--rowin': f(rowin),
    '--orbit': f(orbit),
    '--o-final': f(fin),
    '--o-ui': f(ui),
    '--v-ui': vis(ui),
    '--t-ui': `translateY(${f((1 - ui) * 30, 1)}px)`,
    '--pe-ui': ui > 0.9 ? 'auto' : 'none',
    '--dot-o': f(dot),
    '--we-in': f(weIn),
    '--we-o': f(weO),
    '--wt-in': f(wtIn),
    '--wt-o': f(wtO),
    '--wl-in': f(wlIn),
    '--wl-o': f(wlO),
    '--o-hud': f(hud),
    '--v-hud': vis(hud),
    '--pe0': c[0]! > 0.5 ? 'auto' : 'none',
    '--v-globe': c[0]! > 0.01 ? 'visible' : 'hidden',
    '--pe7': c[7]! > 0.5 ? 'auto' : 'none',
  };
  c.forEach((val, i) => {
    v[`--c${i}`] = f(val);
  });
  for (const [key, val] of Object.entries(v)) root.style.setProperty(key, val);

  const ch = p < 0.06 ? 0 : p < 0.35 ? 1 : p < 0.52 ? 2 : p < 0.79 ? 3 : 4;
  return ch;
}

// Drives the whole scroll story. Progress `p` (0→1) is computed from
// #nx-track/#nx-stage geometry exactly like the reference's compute() — the
// production page is always tall/scrollable (8400px track), so (unlike the
// reference) there's no wheel/virtual-scroll preview fallback to port; that
// existed only for the design tool's own non-scrollable preview sandbox.
export function useNiaHeroEngine(refs: NiaHeroEngineRefs) {
  const [chapter, setChapter] = useState(0);
  const [billing, setBilling] = useState<Billing>('m');
  const [tab, setTab] = useState<ConnectorTab>('s');
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  // Root Lenis instance from <ReactLenis root> in app/page.tsx (undefined
  // outside the landing route, or for one tick before it mounts).
  const lenis = useLenis();

  useLayoutEffect(() => {
    const track = refs.trackRef.current;
    const stage = refs.stageRef.current;
    if (!track || !stage) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const compute = () => {
      const r = track.getBoundingClientRect();
      const total = track.offsetHeight - stage.offsetHeight;
      const p = Math.min(1, Math.max(0, total > 0 ? -r.top / total : 0));
      const ch = apply(p, stage, refs.windowRef.current);
      if (ch !== chapterRef.current) setChapter(ch);
    };

    if (reduce) {
      compute();
      return undefined;
    }

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    // Window scroll stays wired as a fallback; Lenis's own 'scroll' event
    // (fired every rAF tick while it eases, autoRaf: true in page.tsx)
    // drives the same schedule() so the engine reads #nx-track/#nx-stage
    // geometry in lockstep with Lenis's smoothed position instead of only
    // on native scroll events.
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const unsubLenis = lenis?.on('scroll', schedule);
    compute();
    const t1 = setTimeout(schedule, 400);
    const t2 = setTimeout(schedule, 1500);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      unsubLenis?.();
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lenis]);

  return {
    chapter,
    status: STATUS_BY_CHAPTER[chapter]!,
    billing,
    setBilling,
    tab,
    setTab,
  };
}

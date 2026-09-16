'use client';

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

// Isometric "lifecycle loop" diagram — stage cards (Connect/Build/Schedule/
// Run/Monitor) feeding into feature tiles, with hover/pin interactions that
// draw connector lines. Ported as an imperative SVG builder (matrix
// isometric projection + rAF easing) rather than idiomatic React state:
// the geometry math is dense and self-contained, so scoping the original
// vanilla-JS builder to refs is far lower-risk than re-deriving it in JSX.
// Everything below is scoped to this component's own container (refs, not
// `document.getElementById`) so it's safe to mount more than once and
// tears down cleanly (rAF/observers/listeners) on unmount.
export default function HeroDiagram() {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const chipsRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const controls = controlsRef.current;
    const caption = captionRef.current;
    const chips = chipsRef.current;
    if (!svg || !controls || !caption || !chips) return undefined;

    // Reset in case of a dev double-invoke (React StrictMode).
    svg.replaceChildren();
    controls.replaceChildren();
    caption.replaceChildren();
    chips.replaceChildren();

    const CONFIG = {
      overview: 'Hover or tap a stage to see which parts of Nia power it.',
      zones: { left: 'Development', right: 'Production' },
      autoplay: 0,
      stages: [
        {
          label: 'Connect',
          features: ['connectors', 'connections'],
          caption: 'Install a connector once and authorize it — every project reuses the same secure connection.',
        },
        {
          label: 'Build',
          features: ['canvas', 'connections'],
          caption: 'Drag steps onto the canvas and wire up the transforms that turn raw data into something useful.',
        },
        {
          label: 'Schedule',
          features: ['schedule', 'canvas'],
          caption: 'Set a cron schedule or trigger, then let the workflow run itself from here on.',
        },
        {
          label: 'Run',
          features: ['runs', 'dashboards', 'schedule'],
          caption: 'Every run streams its status live, and results land straight in your dashboards.',
        },
        {
          label: 'Monitor',
          features: ['dashboards', 'audit', 'runs'],
          caption: 'Track cost, catch failures early, and see exactly who changed what in the audit log.',
        },
      ],
      features: [
        { id: 'connectors', label: 'Connectors', col: 1, row: 0 },
        { id: 'canvas', label: 'Canvas', col: 2, row: 0 },
        { id: 'schedule', label: 'Schedule', col: 3, row: 0 },
        { id: 'connections', label: 'Connections', col: 1, row: 1 },
        { id: 'runs', label: 'Runs', col: 2, row: 1 },
        { id: 'audit', label: 'Audit Log', col: 3, row: 1 },
        { id: 'dashboards', label: 'Dashboards', col: 4, row: 1 },
      ],
    };

    const P = { xx: 0.9135, xy: -0.3116, yx: 0.4067, yy: 0.6998 };
    const TX = 118;
    const TY = 512;
    const MAT = `matrix(${P.xx} ${P.xy} ${P.yx} ${P.yy} ${TX} ${TY})`;
    const pr = (x: number, y: number, h = 0): [number, number] => [
      TX + P.xx * x + P.yx * y,
      TY + P.xy * x + P.yy * y - h,
    ];
    const pts = (arr: number[][], h = 0) =>
      arr
        .map((p) => {
          const [sx, sy] = pr(p[0] ?? 0, p[1] ?? 0, p.length > 2 ? (p[2] ?? 0) : h);
          return sx.toFixed(1) + ',' + sy.toFixed(1);
        })
        .join(' ');

    const COL = 262;
    const CW = 232;
    const CD = 268;
    const CH = 46;
    const LIFT = 10;
    const TW = 232;
    const TD = 88;
    const ROW = 128;
    const ROW0 = 380;
    const TH = 14;
    const TR = { L: -58, R: 4 * COL + CW + 58, T: 118, B: CD + 62, s: 7, h: 20, Ar: 306, Al: 284, tip: 18 };
    const BUS = 352;

    const NS = 'http://www.w3.org/2000/svg';
    const el = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attrs: Record<string, string | number> = {},
      parent?: Element,
    ): SVGElementTagNameMap[K] => {
      const n = document.createElementNS(NS, tag) as SVGElementTagNameMap[K];
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
      if (parent) parent.appendChild(n);
      return n;
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const defs = el('defs', {}, svg);
    const pat = el('pattern', { id: 'nia-lp-grid', width: 16, height: 16, patternUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M16 0H0V16', class: 'nia-lp-gridline' }, pat);
    const rg = el('radialGradient', { id: 'nia-lp-fade', cx: '50%', cy: '50%', r: '60%' }, defs);
    el('stop', { offset: '52%', 'stop-color': '#fff' }, rg);
    el('stop', { offset: '100%', 'stop-color': '#000' }, rg);
    const mask = el('mask', { id: 'nia-lp-mask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1640, height: 1000 }, defs);
    el('rect', { x: 0, y: 0, width: 1640, height: 1000, fill: 'url(#nia-lp-fade)' }, mask);

    const bg = el('g', { mask: 'url(#nia-lp-mask)', class: 'nia-lp-static' }, svg);
    const bgPlane = el('g', { transform: MAT }, bg);
    el('rect', { x: -2200, y: -1800, width: 5600, height: 4400, fill: 'url(#nia-lp-grid)' }, bgPlane);
    const taken = new Set(CONFIG.features.map((f) => `${f.col},${f.row}`));
    ['0,0', '4,0', '5,0'].forEach((k) => taken.add(k));
    for (let r = -7; r <= 4; r++) {
      for (let c = -5; c <= 10; c++) {
        const x = c * COL;
        const y = ROW0 + r * ROW;
        if (taken.has(`${c},${r}`)) continue;
        const hitsLoop = x < TR.R + 30 && x + TW > TR.L - 30 && y < TR.B + TR.s + 30 && y + TD > -30;
        if (hitsLoop) continue;
        el('rect', { x, y, width: TW, height: TD, class: 'nia-lp-tile-ghost' }, bgPlane);
      }
    }

    const zones = el('g', { transform: MAT, class: 'nia-lp-static' }, svg);
    const zy = TR.B + TR.s + 52;
    el('text', { x: TR.L + 4, y: zy, class: 'nia-lp-zone' }, zones).textContent = CONFIG.zones.left;
    el('text', { x: TR.R - 4, y: zy, class: 'nia-lp-zone', 'text-anchor': 'end' }, zones).textContent = CONFIG.zones.right;

    const track = el('g', { class: 'nia-lp-track nia-lp-static' }, svg);
    {
      const { L, R, T, B, s, Ar, Al, tip } = TR;
      const poly: number[][] = [
        [Al, B + s], [L - s, B + s], [L - s, T - s], [R + s, T - s], [R + s, B + s],
        [Ar, B + s], [Ar - tip, B], [Ar, B - s],
        [R - s, B - s], [R - s, T + s], [L + s, T + s], [L + s, B - s],
        [Al, B - s], [Al - tip, B],
      ];
      const faces: { p: number[]; q: number[]; front: boolean; depth: number }[] = [];
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length]!;
        const nx = (q[1] ?? 0) - (p[1] ?? 0);
        const ny = -((q[0] ?? 0) - (p[0] ?? 0));
        if (P.xy * nx + P.yy * ny <= 0.01) return;
        faces.push({
          p,
          q,
          front: Math.abs(ny) >= Math.abs(nx),
          depth: (pr(p[0] ?? 0, p[1] ?? 0)[1] + pr(q[0] ?? 0, q[1] ?? 0)[1]) / 2,
        });
      });
      faces
        .sort((a, b) => a.depth - b.depth)
        .forEach((f) => {
          el(
            'polygon',
            {
              points: pts([[...f.p, TR.h], [...f.q, TR.h], [...f.q, 0], [...f.p, 0]]),
              class: f.front ? 'nia-lp-track-front' : 'nia-lp-track-side',
            },
            track,
          );
        });
      el('polygon', { points: pts(poly, TR.h), class: 'nia-lp-track-top' }, track);
    }

    const cardsLayer = el('g', {}, svg);
    const cards = CONFIG.stages.map((st, i) => {
      const x = i * COL;
      const y = 0;
      const g = el('g', { class: 'nia-lp-card', tabindex: 0, role: 'button', 'aria-label': `${st.label}: show related tools` });
      const left = el('polygon', { class: 'nia-lp-card-left' }, g);
      const front = el('polygon', { class: 'nia-lp-card-front' }, g);
      const liftG = el('g', {}, g);
      const plane = el('g', { transform: MAT }, liftG);
      const top = el('rect', { x, y, width: CW, height: CD, class: 'nia-lp-card-top' }, plane);
      const deco = el('g', {}, plane);
      el('rect', { x: x + 22, y: y + 82, width: CW - 44, height: CD - 150, class: 'nia-lp-card-inner' }, deco);
      for (let j = 0; j < 3; j++) {
        el('line', { x1: x + 22 + j * 6, y1: y + 14, x2: x + 22 + j * 6, y2: y + 30, class: 'nia-lp-card-grip' }, deco);
      }
      el('rect', { x: x + CW - 62, y: y + CD - 112, width: 40, height: 5, class: 'nia-lp-card-bar' }, deco);
      const dot = el('g', {}, plane);
      el('circle', { cx: x + 70, cy: y + CD - 54, r: 7, class: 'nia-lp-card-dot' }, dot);
      el('circle', { cx: x + 70, cy: y + CD - 54, r: 2.6, class: 'nia-lp-card-dot-core' }, dot);
      const title = el('text', { x: x + 24, y: y + 62, class: 'nia-lp-card-title' }, plane);
      title.textContent = st.label;
      return { i, x, y, g, left, front, liftG, top, deco, dot, title, v: 0, sel: 0, wait: 0.15 + i * 0.09 };
    });
    [...cards].reverse().forEach((c) => cardsLayer.appendChild(c.g));
    svg.appendChild(cardsLayer);

    function drawCard(c: (typeof cards)[number]) {
      const h = CH * c.v + LIFT * c.sel;
      const { x, y } = c;
      c.left.setAttribute('points', pts([[x, y, h], [x, y + CD, h], [x, y + CD, 0], [x, y, 0]]));
      c.front.setAttribute('points', pts([[x, y + CD, h], [x + CW, y + CD, h], [x + CW, y + CD, 0], [x, y + CD, 0]]));
      c.liftG.setAttribute('transform', `translate(0 ${(-h).toFixed(2)})`);
      const faceOp = h < 0.5 ? 0 : Math.min(1, c.v + c.sel);
      c.left.style.fillOpacity = c.front.style.fillOpacity = (0.94 * faceOp).toFixed(3);
      c.left.style.strokeOpacity = c.front.style.strokeOpacity = faceOp.toFixed(3);
      c.top.style.fillOpacity = (0.8 * c.v).toFixed(3);
      c.top.style.strokeOpacity = (0.35 + 0.65 * c.v).toFixed(3);
      c.deco.style.opacity = (0.45 + 0.55 * c.v).toFixed(3);
      c.dot.style.opacity = c.v.toFixed(3);
      c.title.style.opacity = (0.28 + 0.72 * c.v).toFixed(3);
    }

    const linesLayer = el('g', { class: 'nia-lp-static' }, svg);
    let linePaths: { p: SVGPathElement; start: number; end: number }[] = [];

    const tilesLayer = el('g', {}, svg);
    const tiles = CONFIG.features
      .map((f) => {
        const x = f.col * COL;
        const y = ROW0 + f.row * ROW;
        const g = el('g', {});
        const left = el('polygon', { class: 'nia-lp-tile-left' }, g);
        const front = el('polygon', { class: 'nia-lp-tile-front' }, g);
        const liftG = el('g', {}, g);
        const plane = el('g', { transform: MAT }, liftG);
        const top = el('rect', { x, y, width: TW, height: TD, class: 'nia-lp-tile-top' }, plane);
        const labelEl = el('text', { x: x + TW / 2, y: y + TD / 2, class: 'nia-lp-tile-label' }, plane);
        labelEl.textContent = f.label;
        return { ...f, x, y, g, left, front, liftG, top, labelEl, t: 0, depth: pr(x + TW / 2, y + TD / 2)[1] };
      })
      .sort((a, b) => a.depth - b.depth);
    tiles.forEach((t) => tilesLayer.appendChild(t.g));
    const tileById = Object.fromEntries(tiles.map((t) => [t.id, t]));

    function drawTile(t: (typeof tiles)[number]) {
      const h = TH * t.t;
      const { x, y } = t;
      t.left.setAttribute('points', pts([[x, y, h], [x, y + TD, h], [x, y + TD, 0], [x, y, 0]]));
      t.front.setAttribute('points', pts([[x, y + TD, h], [x + TW, y + TD, h], [x + TW, y + TD, 0], [x, y + TD, 0]]));
      t.liftG.setAttribute('transform', `translate(0 ${(-h).toFixed(2)})`);
      const op = h < 0.3 ? 0 : t.t;
      t.left.style.fillOpacity = t.front.style.fillOpacity = op.toFixed(3);
      t.left.style.strokeOpacity = t.front.style.strokeOpacity = op.toFixed(3);
      t.top.style.fillOpacity = t.t.toFixed(3);
      t.top.style.strokeOpacity = (0.2 + 0.8 * t.t).toFixed(3);
      t.labelEl.style.fillOpacity = (0.42 + 0.58 * t.t).toFixed(3);
    }

    function buildLines(idx: number | null) {
      linesLayer.replaceChildren();
      linePaths = [];
      if (idx == null) return;
      const fts = CONFIG.stages[idx]!.features
        .map((id) => tileById[id])
        .filter((t): t is NonNullable<typeof t> => Boolean(t));
      if (!fts.length) return;
      const cx = idx * COL + CW / 2;
      const xs = fts.map((t) => t.x + TW / 2);
      const minX = Math.min(cx, ...xs);
      const maxX = Math.max(cx, ...xs);
      const add = (a: number[], b: number[], start: number, end: number) => {
        const [x1, y1] = pr(a[0] ?? 0, a[1] ?? 0);
        const [x2, y2] = pr(b[0] ?? 0, b[1] ?? 0);
        const p = el(
          'path',
          { d: `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`, pathLength: 1, class: 'nia-lp-line' },
          linesLayer,
        );
        p.style.strokeDasharray = '1 1';
        p.style.strokeDashoffset = '1';
        linePaths.push({ p, start, end });
      };
      add([cx, CD], [cx, BUS], 0, 0.3);
      if (minX < cx) add([cx, BUS], [minX, BUS], 0.3, 0.62);
      if (maxX > cx) add([cx, BUS], [maxX, BUS], 0.3, 0.62);
      fts.forEach((t) => add([t.x + TW / 2, BUS], [t.x + TW / 2, t.y], 0.62, 1));
    }

    function drawLines(prog: number) {
      for (const l of linePaths) {
        const local = Math.max(0, Math.min(1, (prog - l.start) / (l.end - l.start)));
        l.p.style.strokeDashoffset = (1 - local).toFixed(4);
      }
    }

    const state = { target: null as number | null, hover: null as number | null, pinned: null as number | null, prog: 1, trackA: 0, zoneA: 0, userActed: false };
    let raf = 0;
    let last = 0;
    let started = false;

    function setTarget(idx: number | null) {
      if (idx === state.target) return;
      state.target = idx;
      buildLines(idx);
      state.prog = reduceMotion ? 1 : -0.25;
      updateUI();
      kick();
    }
    const resolve = () => setTarget(state.hover ?? state.pinned);

    const canvasEl = svg.parentElement as HTMLElement;
    function centerOn(idx: number | null, smooth = true) {
      if (!canvasEl || canvasEl.scrollWidth <= canvasEl.clientWidth + 1) return;
      const x = idx == null ? 820 : pr(idx * COL + CW / 2, CD)[0];
      const scale = svg!.getBoundingClientRect().width / 1640;
      canvasEl.scrollTo({ left: x * scale - canvasEl.clientWidth / 2, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
    }

    function frame(now: number) {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 9);
      let moving = false;
      const ease = (o: Record<string, any>, key: string, target: number) => {
        const d = target - (o[key] as number);
        if (Math.abs(d) > 0.001) {
          o[key] += d * k;
          moving = true;
        } else o[key] = target;
      };
      const T = state.target;

      cards.forEach((c) => {
        if (c.wait > 0 && !reduceMotion) {
          c.wait -= dt;
          moving = true;
          drawCard(c);
          return;
        }
        ease(c, 'v', T == null || T === c.i ? 1 : 0);
        ease(c, 'sel', T === c.i ? 1 : 0);
        drawCard(c);
      });
      tiles.forEach((t) => {
        ease(t, 't', T != null && CONFIG.stages[T]!.features.includes(t.id) ? 1 : 0);
        drawTile(t);
      });
      ease(state, 'trackA', T == null ? 1 : 0.28);
      ease(state, 'zoneA', T == null ? 1 : 0.4);
      track.style.opacity = state.trackA.toFixed(3);
      zones.style.opacity = state.zoneA.toFixed(3);

      if (state.prog < 1) {
        state.prog = Math.min(1, state.prog + dt / 0.75);
        moving = true;
      }
      drawLines(state.prog);

      if (moving) raf = requestAnimationFrame(frame);
      else {
        raf = 0;
        last = 0;
      }
    }
    function kick() {
      if (started && !raf) raf = requestAnimationFrame(frame);
    }

    const acted = () => {
      state.userActed = true;
    };
    const togglePin = (i: number) => {
      acted();
      state.pinned = state.pinned === i ? null : i;
      resolve();
    };

    const cardCleanups: (() => void)[] = [];
    cards.forEach((c) => {
      const onEnter = () => {
        state.hover = c.i;
        resolve();
      };
      const onClick = () => togglePin(c.i);
      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePin(c.i);
        }
      };
      const onFocus = () => {
        state.hover = c.i;
        resolve();
      };
      const onBlur = () => {
        state.hover = null;
        resolve();
      };
      c.g.addEventListener('pointerenter', onEnter);
      c.g.addEventListener('click', onClick);
      c.g.addEventListener('keydown', onKeydown);
      c.g.addEventListener('focus', onFocus);
      c.g.addEventListener('blur', onBlur);
      cardCleanups.push(() => {
        c.g.removeEventListener('pointerenter', onEnter);
        c.g.removeEventListener('click', onClick);
        c.g.removeEventListener('keydown', onKeydown);
        c.g.removeEventListener('focus', onFocus);
        c.g.removeEventListener('blur', onBlur);
      });
    });
    const onSvgLeave = () => {
      state.hover = null;
      resolve();
    };
    svg.addEventListener('pointerleave', onSvgLeave);
    svg.addEventListener('pointerenter', acted);
    const onKeydownEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        state.pinned = null;
        state.hover = null;
        resolve();
      }
    };
    document.addEventListener('keydown', onKeydownEscape);

    const labels = ['Overview', ...CONFIG.stages.map((s) => s.label)];
    const buttons = labels.map((label, j) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nia-lp-btn';
      b.textContent = label;
      b.addEventListener('click', () => {
        acted();
        state.pinned = j === 0 ? null : j - 1;
        state.hover = null;
        resolve();
        centerOn(state.pinned);
      });
      controls.appendChild(b);
      return b;
    });

    function updateUI() {
      const T = state.target;
      buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(T == null ? j === 0 : j - 1 === T)));
      chips!.replaceChildren();
      if (T == null) {
        caption!.textContent = CONFIG.overview;
        return;
      }
      const st = CONFIG.stages[T]!;
      const bold = document.createElement('b');
      bold.textContent = st.label + '.';
      caption!.replaceChildren(bold, ' ' + st.caption);
      st.features.forEach((id) => {
        const f = tileById[id];
        if (!f) return;
        const li = document.createElement('li');
        li.textContent = f.label;
        chips!.appendChild(li);
      });
    }

    cards.forEach(drawCard);
    tiles.forEach(drawTile);
    track.style.opacity = '0';
    zones.style.opacity = '0';
    updateUI();
    centerOn(null, false);

    const start = () => {
      if (!started) {
        started = true;
        kick();
      }
    };
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) start();
          });
        },
        { threshold: 0.25 },
      );
      io.observe(svg);
    } else {
      start();
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      cardCleanups.forEach((fn) => fn());
      svg.removeEventListener('pointerleave', onSvgLeave);
      svg.removeEventListener('pointerenter', acted);
      document.removeEventListener('keydown', onKeydownEscape);
      svg.replaceChildren();
      controls.replaceChildren();
      caption.replaceChildren();
      chips.replaceChildren();
    };
  }, []);

  return (
    <div ref={rootRef} style={diagramRoot}>
      <div style={diagramCanvas} className="nia-hero-loop-canvas">
        <svg ref={svgRef} viewBox="0 30 1640 860" role="group" aria-label="Product lifecycle diagram" />
      </div>
      <div style={diagramControls} ref={controlsRef} aria-label="Choose a stage" />
      <div style={diagramInfo} aria-live="polite">
        <p style={diagramCaption} ref={captionRef} />
        <ul style={diagramChips} ref={chipsRef} className="nia-hero-loop-chips" />
      </div>

      <style>{`
        .nia-hero-loop-canvas { margin-top: 0; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
        .nia-hero-loop-canvas::-webkit-scrollbar { display: none; }
        .nia-hero-loop-canvas svg { display: block; width: 100%; min-width: 620px; height: auto; user-select: none; -webkit-user-select: none; font-family: var(--font-plex-mono); }

        .nia-lp-btn {
          font: inherit; font-family: var(--font-plex-mono); font-size: 12.5px; padding: 7px 12px; cursor: pointer;
          color: var(--text); background: var(--surface); border: 1px solid var(--line);
          border-radius: 8px; transition: transform .15s ease, box-shadow .15s ease, background-color .15s ease, border-color .15s ease;
        }
        .nia-lp-btn:hover { border-color: var(--line-strong); }
        .nia-lp-btn[aria-pressed="true"] { background: var(--primary-soft); border-color: var(--primary); color: var(--primary); }
        .nia-lp-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

        .nia-hero-loop-chips li { font-size: 11.5px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--secondary); }

        .nia-lp-static { pointer-events: none; }
        .nia-lp-gridline { fill: none; stroke: var(--line); stroke-width: .7; }
        .nia-lp-tile-ghost { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
        .nia-lp-zone { font-size: 22px; fill: var(--secondary); letter-spacing: .02em; }

        .nia-lp-track polygon { stroke: var(--text); stroke-width: 1.2; stroke-linejoin: round; }
        .nia-lp-track-top { fill: var(--primary-soft); }
        .nia-lp-track-front { fill: var(--primary); }
        .nia-lp-track-side { fill: var(--primary-hover); }

        .nia-lp-card { cursor: pointer; outline: none; }
        .nia-lp-card-top { fill: var(--surface); stroke: var(--text); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
        .nia-lp-card-left { fill: var(--subtle); stroke: var(--text); stroke-width: 1.4; stroke-linejoin: round; }
        .nia-lp-card-front { fill: var(--line); stroke: var(--text); stroke-width: 1.4; stroke-linejoin: round; }
        .nia-lp-card-inner { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
        .nia-lp-card-grip { stroke: var(--muted); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
        .nia-lp-card-bar { fill: var(--subtle); }
        .nia-lp-card-title { font-size: 23px; fill: var(--text); }
        .nia-lp-card-dot { fill: var(--primary); stroke: var(--text); stroke-width: 1; vector-effect: non-scaling-stroke; }
        .nia-lp-card-dot-core { fill: var(--text); }
        .nia-lp-card:focus-visible .nia-lp-card-top { stroke-width: 3.2; stroke: var(--primary); }

        .nia-lp-line { fill: none; stroke: var(--primary); stroke-width: 1.8; stroke-linecap: square; }

        .nia-lp-tile-top { fill: var(--surface); stroke: var(--text); stroke-width: 1.3; vector-effect: non-scaling-stroke; }
        .nia-lp-tile-left { fill: var(--subtle); stroke: var(--text); stroke-width: 1.2; stroke-linejoin: round; }
        .nia-lp-tile-front { fill: var(--line); stroke: var(--text); stroke-width: 1.2; stroke-linejoin: round; }
        .nia-lp-tile-label { font-size: 15px; fill: var(--text); text-anchor: middle; dominant-baseline: central; }
      `}</style>
    </div>
  );
}

const diagramRoot: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
};

const diagramCanvas: CSSProperties = {
  width: '100%',
};

const diagramControls: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 14,
};

const diagramInfo: CSSProperties = {
  marginTop: 16,
  minHeight: '4.5em',
};

const diagramCaption: CSSProperties = {
  margin: 0,
  maxWidth: '46ch',
  fontSize: 13.5,
  lineHeight: 1.6,
  color: 'var(--secondary)',
};

const diagramChips: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  margin: '10px 0 0',
  padding: 0,
  listStyle: 'none',
};

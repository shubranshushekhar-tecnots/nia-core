'use client';

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { COLOR, HANDOFF_WINDOW, HERO_APPROACH_VH, HERO_PIN_VH, REST_WINDOW, nodeById } from './config';
import { hlFontFamily } from '../hairline/styles';
import { geistMono } from './heroCanvasFonts';
import HeroCanvasLayer from './HeroCanvasLayer';
import { useHeroApproachProgress } from './useHeroApproachProgress';
import { useHeroScrollProgress } from './useHeroScrollProgress';

// Two stacked blocks instead of one giant sticky stage:
//
// 1. Approach block (normal document flow, NOT sticky): the headline stays
//    fully visible and scrolls away with the page like a normal section —
//    real scroll, no viewport freeze. The only thing this block animates is
//    the small Supabase preview window, which floats via `position: fixed`
//    from its rest spot (next to the ghost span, inline with the headline)
//    to dead-center of the viewport as the block scrolls through. See
//    useHeroApproachProgress.ts.
//
// 2. Pin block (the scroll-jacked part, unchanged in spirit from before):
//    a sticky stage that takes over exactly where the approach block left
//    off — window already centered, growing to fullscreen while chrome
//    fades in. See useHeroScrollProgress.ts.
//
// The handoff is seamless because the approach block's own progress reaches
// 1 (window fully centered) at exactly the scroll position where the pin
// block's sticky stage starts sticking — that's just how normal document
// flow + `position: sticky` compose, no extra coordination needed. Both
// blocks render their own instance of the canvas layer (dot grid + node
// cards + connectors) via the shared HeroCanvasLayer so they're pixel-
// identical at the handoff frame.
//
// `heroRef` mirrors LandingPage.tsx's existing prop pattern (Nav reads this
// section's bounds to drive its own transparent → solid-black → frosted-
// light theme sweep — see Nav.tsx). It still wraps both blocks so that
// integration needs no changes.
export default function HeroCanvasSection({ heroRef }: { heroRef: RefObject<HTMLElement> }) {
  const approachBlockRef = useRef<HTMLDivElement>(null);
  const approachWindowRef = useRef<HTMLDivElement>(null);
  const approachCanvasRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);

  const pinWrapperRef = useRef<HTMLDivElement>(null);
  const pinWindowRef = useRef<HTMLDivElement>(null);
  const pinCanvasRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const railFillRef = useRef<HTMLDivElement>(null);

  // Which node (if any) is currently clicked — shared between both canvas
  // instances (approach chip + pin fullscreen) so the outline ring stays in
  // sync no matter which instance is currently visible, and drives the
  // status bar's "Selected · <node>" text below.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onSelectId = (id: string) => setSelectedId((prev) => (prev === id ? null : id));

  // Row counter: 0 -> 748,494 once on mount, cubic ease-out over 1800ms —
  // matches the reference's componentDidMount behavior. Independent of the
  // scroll-driven reveal/growth machinery above (runs once, real time).
  const [rows, setRows] = useState(0);
  useEffect(() => {
    const target = 748494;
    const duration = 1800;
    const start = Date.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      setRows(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useHeroApproachProgress({
    blockEl: approachBlockRef,
    windowEl: approachWindowRef,
    canvasEl: approachCanvasRef,
    ghostEl: ghostRef,
  });

  useHeroScrollProgress({
    heroEl: heroRef,
    pinWrapperEl: pinWrapperRef,
    windowEl: pinWindowRef,
    canvasEl: pinCanvasRef,
    chromeEl: chromeRef,
    railFillEl: railFillRef,
  });

  const selectedNode = selectedId ? nodeById(selectedId) : null;
  const statusText = selectedNode ? `Selected · ${selectedNode.title}` : 'Nightly · 5 of 5 checks passed';

  return (
    <section
      ref={heroRef as RefObject<HTMLElement>}
      className={`${geistMono.variable} nia-hero-canvas-section`}
      style={sectionStyle}
    >
      {/* -------- approach block: normal scroll, headline scrolls away, window floats to center -------- */}
      <div ref={approachBlockRef} className="nia-hero-approach" style={approachBlockStyle}>
        <div ref={approachWindowRef} className="nia-hero-approach-window" style={approachWindowBaseStyle}>
          <HeroCanvasLayer canvasRef={approachCanvasRef} selectedId={selectedId} onSelectId={onSelectId} />
        </div>

        <div className="nia-hero-text" style={textLayerStyle}>
          <div className="nia-hero-text-inner" style={textInnerStyle}>
            <h1 style={h1Style}>
              <span style={h1Line}>
                <span style={{ color: COLOR.textPrimary }}>Extract. Transform.</span>{' '}
                <span style={{ color: COLOR.brandVioletOnBlack }}>Load.</span>
              </span>
              <span style={h1LineCenter}>
                <span style={{ color: COLOR.textPrimary }}>All on one</span>
                <span ref={ghostRef} aria-hidden="true" className="nia-hero-ghost" style={ghostSpanStyle} />
                <span style={{ color: COLOR.textPrimary }}>canvas.</span>
              </span>
            </h1>

            <p style={subStyle}>
              Draw the ETL pipeline, schedule it, and wake up to dashboards that filled themselves.
            </p>
          </div>

          <div
            aria-hidden="true"
            className={`${geistMono.className} nia-hero-rest-corner`}
            style={restBottomLeftStyle}
          >
            <span style={restDotStyle} />
            SCROLL TO WATCH A NIGHT
          </div>
          <div
            aria-hidden="true"
            className={`${geistMono.className} nia-hero-rest-corner`}
            style={restBottomRightStyle}
          >
            REEL 01 · 00:00:00:00
          </div>
        </div>
      </div>

      {/* -------- pin block: sticky, window already centered, grows to fullscreen -------- */}
      <div ref={pinWrapperRef} className="nia-hero-pin-wrapper" style={pinWrapperStyle}>
        <div className="nia-hero-pin-stage" style={pinStageStyle}>
          <div ref={pinWindowRef} className="nia-hero-window" style={pinWindowBaseStyle}>
            <HeroCanvasLayer canvasRef={pinCanvasRef} selectedId={selectedId} onSelectId={onSelectId} />
          </div>

          <div ref={chromeRef} className={geistMono.className} style={chromeLayerStyle}>
            {/* top rail */}
            <div style={topRailStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={railLabelStrong}>REEL 01 — THE NIGHTLY</span>
                <span style={railLabelMuted}>RUN 4,118</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 6, height: 6, background: COLOR.brandViolet, flex: 'none' }} />
                  <span style={railLabelStrong}>CHECKS 5/5</span>
                </div>
                <span style={railLabelMuted}>00:01:04:12</span>
              </div>
            </div>

            <div style={chromeBottomLeft}>
              READ · SUPABASE-ORDERS
              <span style={{ display: 'block', color: COLOR.chromeStrong, fontSize: 20, marginTop: 4 }}>
                {rows.toLocaleString('en-US')} rows
              </span>
            </div>

            {/* status bar */}
            <div style={statusBarStyle}>
              <span style={{ ...railLabelStrong, width: 300 }}>{statusText}</span>
              <div style={progressRailTrack}>
                <div ref={railFillRef} style={progressRailFill} />
              </div>
              <div style={{ width: 300, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <span style={chipStyleGhost}>Logs</span>
                <span style={chipStyleSolid}>Run now</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes hc-act-a { 0%, 1% { border-color: #e4e5e8; } 2%, 5% { border-color: #101014; } 7%, 100% { border-color: #e4e5e8; } }
        @keyframes hc-act-b { 0%, 8% { border-color: #e4e5e8; } 9%, 15% { border-color: #101014; } 17%, 100% { border-color: #e4e5e8; } }
        @keyframes hc-act-c { 0%, 21% { border-color: #e4e5e8; } 22%, 50% { border-color: #101014; } 52%, 100% { border-color: #e4e5e8; } }
        @keyframes hc-act-d { 0%, 71% { border-color: #e4e5e8; } 72%, 78% { border-color: #101014; } 80%, 100% { border-color: #e4e5e8; } }
        @keyframes hc-act-e { 0%, 85% { border-color: #e4e5e8; } 86%, 96% { border-color: #101014; } 98%, 100% { border-color: #e4e5e8; } }

        @keyframes hc-led-a { 0%, 1% { opacity: 0; } 2%, 5% { opacity: 1; } 7%, 100% { opacity: 0; } }
        @keyframes hc-led-b { 0%, 8% { opacity: 0; } 9%, 15% { opacity: 1; } 17%, 100% { opacity: 0; } }
        @keyframes hc-led-c { 0%, 21% { opacity: 0; } 22%, 50% { opacity: 1; } 52%, 100% { opacity: 0; } }
        @keyframes hc-led-d { 0%, 71% { opacity: 0; } 72%, 78% { opacity: 1; } 80%, 100% { opacity: 0; } }
        @keyframes hc-led-e { 0%, 85% { opacity: 0; } 86%, 96% { opacity: 1; } 98%, 100% { opacity: 0; } }

        .hc-act-a { animation: hc-act-a 7.5s linear infinite; }
        .hc-act-b { animation: hc-act-b 7.5s linear infinite; }
        .hc-act-c { animation: hc-act-c 7.5s linear infinite; }
        .hc-act-d { animation: hc-act-d 7.5s linear infinite; }
        .hc-act-e { animation: hc-act-e 7.5s linear infinite; }

        .hc-led-a { animation: hc-led-a 7.5s linear infinite; }
        .hc-led-b { animation: hc-led-b 7.5s linear infinite; }
        .hc-led-c { animation: hc-led-c 7.5s linear infinite; }
        .hc-led-d { animation: hc-led-d 7.5s linear infinite; }
        .hc-led-e { animation: hc-led-e 7.5s linear infinite; }

        @keyframes hc-pk1 { 0% { stroke-dashoffset: 20; opacity: 0; } 3% { opacity: 1; } 9% { stroke-dashoffset: -80; opacity: 1; } 11%, 100% { stroke-dashoffset: -80; opacity: 0; } }
        @keyframes hc-pk2 { 0%, 14% { stroke-dashoffset: 20; opacity: 0; } 16% { opacity: 1; } 22% { stroke-dashoffset: -80; opacity: 1; } 24%, 100% { stroke-dashoffset: -80; opacity: 0; } }
        @keyframes hc-pk3 { 0%, 49% { stroke-dashoffset: 20; opacity: 0; } 51% { opacity: 1; } 72% { stroke-dashoffset: -1076; opacity: 1; } 74%, 100% { stroke-dashoffset: -1076; opacity: 0; } }
        @keyframes hc-pk4 { 0%, 77% { stroke-dashoffset: 20; opacity: 0; } 79% { opacity: 1; } 86% { stroke-dashoffset: -80; opacity: 1; } 88%, 100% { stroke-dashoffset: -80; opacity: 0; } }
        @keyframes hc-pk5 { 0%, 77% { stroke-dashoffset: 20; opacity: 0; } 79% { opacity: 1; } 90% { stroke-dashoffset: -248; opacity: 1; } 92%, 100% { stroke-dashoffset: -248; opacity: 0; } }

        .hc-pk1 { stroke-dasharray: 20 4000; animation: hc-pk1 7.5s linear infinite; }
        .hc-pk2 { stroke-dasharray: 20 4000; animation: hc-pk2 7.5s linear infinite; }
        .hc-pk3 { stroke-dasharray: 20 4000; animation: hc-pk3 7.5s linear infinite; }
        .hc-pk4 { stroke-dasharray: 20 4000; animation: hc-pk4 7.5s linear infinite; }
        .hc-pk5 { stroke-dasharray: 20 4000; animation: hc-pk5 7.5s linear infinite; }

        @media (prefers-reduced-motion: reduce) {
          .nia-hero-canvas-section { height: auto !important; }
          .nia-hero-approach { height: auto !important; }
          .nia-hero-approach-window { display: none !important; }
          .nia-hero-text { position: static !important; inset: auto !important; }
          .nia-hero-rest-corner { display: none !important; }
          .nia-hero-pin-wrapper { height: auto !important; }
          .nia-hero-pin-stage { position: relative !important; height: auto !important; min-height: 100vh; }

          .hc-act-a, .hc-act-b, .hc-act-c, .hc-act-d, .hc-act-e,
          .hc-led-a, .hc-led-b, .hc-led-c, .hc-led-d, .hc-led-e,
          .hc-pk1, .hc-pk2, .hc-pk3, .hc-pk4, .hc-pk5 { animation: none !important; }
          .hc-pk1, .hc-pk2, .hc-pk3, .hc-pk4, .hc-pk5 { opacity: 0; }
        }

        @media (max-width: 768px) {
          .nia-hero-canvas-section { height: auto !important; }

          .nia-hero-approach { height: auto !important; padding: 96px 20px 32px; }
          .nia-hero-approach-window { display: none !important; }
          .nia-hero-ghost { display: none !important; }
          .nia-hero-text { position: static !important; inset: auto !important; }
          .nia-hero-text-inner { padding-top: 0 !important; }
          .nia-hero-rest-corner { display: none !important; }

          .nia-hero-pin-wrapper { height: auto !important; }
          .nia-hero-pin-stage { position: relative !important; height: auto !important; padding: 0 20px 48px; }
          .nia-hero-window {
            position: relative !important;
            left: auto !important; top: auto !important;
            width: 100% !important; height: min(38vw, 200px) !important;
            opacity: 1 !important;
          }
        }
      `}</style>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Static styles
// ---------------------------------------------------------------------------

const sectionStyle: CSSProperties = {
  position: 'relative',
  background: COLOR.ground,
};

const approachBlockStyle: CSSProperties = {
  position: 'relative',
  height: `${HERO_APPROACH_VH}vh`,
  background: COLOR.ground,
};

// Small preview window that floats via `position: fixed` from its rest spot
// (next to the ghost span) to viewport-center — see useHeroApproachProgress.
// Starts at opacity 0 (JS fades it in once it has measured the ghost span,
// avoiding a flash at the wrong position on first paint).
const approachWindowBaseStyle: CSSProperties = {
  position: 'fixed',
  overflow: 'hidden',
  background: COLOR.canvasBg,
  border: '1px solid #1C1C1C',
  borderRadius: 2,
  opacity: 0,
  zIndex: 5,
  willChange: 'width, height, left, top, opacity',
  contain: 'layout paint',
  width: REST_WINDOW.w,
  height: REST_WINDOW.h,
};

const pinWrapperStyle: CSSProperties = {
  position: 'relative',
  height: `${HERO_PIN_VH}vh`,
};

const pinStageStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  height: '100vh',
  overflow: 'hidden',
  background: COLOR.ground,
};

const pinWindowBaseStyle: CSSProperties = {
  position: 'absolute',
  overflow: 'hidden',
  background: COLOR.canvasBg,
  border: '1px solid #1C1C1C',
  borderRadius: 2,
  // Hidden until the pin block's sticky stage has actually stuck — before
  // that, the stage (and this window) still render at their normal in-flow
  // position, which would otherwise peek into view from below while the
  // approach block's own floating card is still mid-transit. JS flips this
  // to 1 at the exact handoff instant (see useHeroScrollProgress).
  opacity: 0,
  willChange: 'width, height, left, top, opacity',
  contain: 'layout paint',
  width: HANDOFF_WINDOW.w,
  height: HANDOFF_WINDOW.h,
  // CSS-only centered starting position (matches useHeroScrollProgress's
  // first applied frame) so there's no flash before JS takes over. Sized
  // to HANDOFF_WINDOW, not REST_WINDOW — that's the size the approach
  // block has already grown the window to by the time this block takes
  // over (see config.ts's HANDOFF_WINDOW comment).
  left: `calc(50% - ${HANDOFF_WINDOW.w / 2}px)`,
  top: `calc(50% - ${HANDOFF_WINDOW.h / 2}px)`,
};

const textLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  fontFamily: hlFontFamily,
};

const textInnerStyle: CSSProperties = {
  boxSizing: 'border-box',
  maxWidth: 1480,
  padding: '300px clamp(24px,6vw,56px) 40px',
};

const h1Style: CSSProperties = {
  margin: 0,
  fontWeight: 300,
  fontSize: 'clamp(44px, 8.4vw, 124px)',
  lineHeight: 0.94,
  letterSpacing: '-0.028em',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const h1Line: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
};

// Second headline line: inline-flex, same natural-flow approach as line 1
// (h1Line) — NOT a `1fr auto 1fr` grid. That grid was the bug: two equal-
// width `1fr` tracks size themselves off the row's available width, not
// off "All on one"'s actual text length, so the text (hugging its own
// column's left edge via justifySelf) left a large dead gap before the
// ghost/image column started, regardless of how short the text was. Flex
// packs "All on one" → ghost/image → "canvas." tightly against each other
// (just `gap` between them) and pushes any leftover space to the end of
// the row, exactly like normal inline text flow — so the image sits where
// it visually belongs regardless of viewport width. `alignItems: 'center'`
// (overriding the shared baseline alignment used by line 1) vertically
// centers the small inline image on the text row, like an inline chip,
// rather than bottom-aligning it to the text baseline. The approach
// window's rest position tracks the ghost span's actual live position
// (see useHeroApproachProgress), so it always matches wherever this
// layout puts it.
const h1LineCenter: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  columnGap: 26,
  rowGap: 6,
};

// Reserves the *displayed* (post-scale) footprint of the crop, which is
// deliberately smaller than REST_WINDOW (the crop's native size in canvas
// px — see config.ts) so the visual reads as a small inline chip sitting
// close to the text, Material-reference style, rather than a large window.
// Sized off `height` (in em, so it tracks the headline's own clamp()'d
// font-size) with `width: auto` + `aspectRatio` deriving the width from
// it — not the other way around — because useHeroApproachProgress's
// `restScale` is computed purely from the ghost's measured *width*
// (REST_WINDOW's ratio is applied uniformly from there), so letting width
// be the free/derived dimension is what actually makes the displayed
// card's height track this element's height. Tuned to roughly match the
// surrounding line's x-height (that line has no ascenders/descenders) so
// the card doesn't read as short/thin next to the huge headline type.
const ghostSpanStyle: CSSProperties = {
  display: 'inline-block',
  position: 'relative',
  top: 10,
  height: '0.62em',
  width: 'auto',
  aspectRatio: `${REST_WINDOW.w} / ${REST_WINDOW.h}`,
  visibility: 'hidden',
};

const subStyle: CSSProperties = {
  margin: '28px 0 0',
  maxWidth: 460,
  fontSize: 19,
  lineHeight: 1.55,
  color: COLOR.textSecondary,
};

const restDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: COLOR.brandViolet,
};

const restBottomLeftStyle: CSSProperties = {
  position: 'absolute',
  left: 'clamp(20px,4vw,56px)',
  bottom: 40,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 11,
  letterSpacing: '.18em',
  textTransform: 'uppercase',
  color: COLOR.textDim,
};

const restBottomRightStyle: CSSProperties = {
  position: 'absolute',
  right: 'clamp(20px,4vw,56px)',
  bottom: 40,
  fontSize: 11,
  letterSpacing: '.18em',
  color: COLOR.textDim,
};

const chromeLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 3,
  opacity: 0,
  pointerEvents: 'none',
  fontFamily: 'var(--font-hero-mono)',
};

const railLabelStrong: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: COLOR.chromeStrong,
};

const railLabelMuted: CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  letterSpacing: '.12em',
  color: COLOR.chromeMuted,
};

const topRailStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 52,
  boxSizing: 'border-box',
  padding: '0 20px',
  borderBottom: `1px solid ${COLOR.cardBorder}`,
  background: '#FFFFFF',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const statusBarStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: 48,
  boxSizing: 'border-box',
  padding: '0 20px',
  borderTop: `1px solid ${COLOR.cardBorder}`,
  background: '#FFFFFF',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
};

const chipStyleGhost: CSSProperties = {
  height: 32,
  padding: '0 14px',
  border: `1px solid ${COLOR.cardBorder}`,
  borderRadius: 8,
  background: '#FFFFFF',
  color: COLOR.chromeMuted,
  fontSize: 13,
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
};

const chipStyleSolid: CSSProperties = {
  height: 32,
  padding: '0 14px',
  border: `1px solid ${COLOR.chromeStrong}`,
  borderRadius: 8,
  background: COLOR.chromeStrong,
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
};

const chromeBottomLeft: CSSProperties = {
  position: 'absolute',
  left: 'clamp(20px,4vw,40px)',
  bottom: 92,
  fontSize: 11,
  letterSpacing: '.14em',
  color: COLOR.chromeMuted,
};

const progressRailTrack: CSSProperties = {
  flexGrow: 1,
  maxWidth: 520,
  height: 3,
  background: COLOR.railTrack,
  overflow: 'hidden',
};

const progressRailFill: CSSProperties = {
  height: '100%',
  width: '0%',
  background: COLOR.brandViolet,
};

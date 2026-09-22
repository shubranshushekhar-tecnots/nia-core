'use client';

import { useRef, type CSSProperties, type RefObject } from 'react';
import { COLOR, HERO_APPROACH_VH, HERO_PIN_VH, REST_WINDOW } from './config';
import { geistMono, geistSans } from './heroCanvasFonts';
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
    ghostEl: ghostRef,
    chromeEl: chromeRef,
    railFillEl: railFillRef,
  });

  return (
    <section
      ref={heroRef as RefObject<HTMLElement>}
      className={`${geistSans.variable} ${geistMono.variable} nia-hero-canvas-section`}
      style={sectionStyle}
    >
      {/* -------- approach block: normal scroll, headline scrolls away, window floats to center -------- */}
      <div ref={approachBlockRef} className="nia-hero-approach" style={approachBlockStyle}>
        <div ref={approachWindowRef} className="nia-hero-approach-window" style={approachWindowBaseStyle}>
          <HeroCanvasLayer canvasRef={approachCanvasRef} />
        </div>

        <div className="nia-hero-text" style={textLayerStyle}>
          <div className="nia-hero-text-inner" style={textInnerStyle}>
            <h1 className={geistSans.className} style={h1Style}>
              <span style={h1Line}>
                <span style={{ color: COLOR.textPrimary }}>Extract. Transform.</span>{' '}
                <span style={{ color: COLOR.brandVioletOnBlack }}>Load.</span>
              </span>
              <span style={h1LineCenter}>
                <span style={{ color: COLOR.textPrimary, justifySelf: 'start', gridColumn: 1 }}>All on one</span>
                <span ref={ghostRef} aria-hidden="true" className="nia-hero-ghost" style={ghostSpanStyle} />
                <span style={{ color: COLOR.textPrimary, justifySelf: 'start', gridColumn: 3 }}>canvas.</span>
              </span>
            </h1>

            <p className={geistSans.className} style={subStyle}>
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
            <HeroCanvasLayer canvasRef={pinCanvasRef} />
          </div>

          <div ref={chromeRef} className={geistMono.className} style={chromeLayerStyle}>
            <div style={chromeTopLeft}>REEL 01 — THE NIGHTLY · RUN 4,118</div>
            <div style={chromeTopRight}>CHECKS 5/5 · 00:01:04:12</div>
            <div style={chromeBottomLeft}>
              READ · SUPABASE-ORDERS
              <span style={{ display: 'block', color: COLOR.chromeStrong, fontSize: 20, marginTop: 4 }}>
                748,494 rows
              </span>
            </div>
            <div style={progressRailTrack}>
              <div ref={railFillRef} style={progressRailFill} />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .nia-hero-canvas-section { height: auto !important; }
          .nia-hero-approach { height: auto !important; }
          .nia-hero-approach-window { display: none !important; }
          .nia-hero-text { position: static !important; inset: auto !important; }
          .nia-hero-rest-corner { display: none !important; }
          .nia-hero-pin-wrapper { height: auto !important; }
          .nia-hero-pin-stage { position: relative !important; height: auto !important; min-height: 100vh; }
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
  width: REST_WINDOW.w,
  height: REST_WINDOW.h,
  // CSS-only centered starting position (matches useHeroScrollProgress's
  // first applied frame) so there's no flash before JS takes over.
  left: `calc(50% - ${REST_WINDOW.w / 2}px)`,
  top: `calc(50% - ${REST_WINDOW.h / 2}px)`,
};

const textLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  fontFamily: 'var(--font-hero-sans)',
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

// Second headline line: a 3-column grid (`1fr auto 1fr`) rather than flex —
// `justify-content: space-between` only equalizes the *gaps* around the
// ghost span, so it drifts toward whichever side text ("All on one" vs
// "canvas.") is narrower. The grid's two `1fr` columns always claim equal
// width regardless of their text's length, so the middle (auto-sized) ghost
// column is guaranteed to sit at the row's true horizontal center; each
// text span uses `justifySelf` to hug its own edge within its `1fr` column.
// `alignItems: 'center'` (overriding the shared baseline alignment used by
// line 1) vertically centers the small inline image on the text row, like
// an inline chip, rather than bottom-aligning it to the text baseline. The
// approach window's rest position tracks the ghost span's actual live
// position (see useHeroApproachProgress), so it always matches wherever
// this layout puts it.
const h1LineCenter: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'center',
  width: '100%',
  columnGap: 6,
};

// Reserves the *displayed* (post-scale) footprint of the crop, which is
// deliberately smaller than REST_WINDOW (the crop's native size in canvas
// px — see config.ts) so the visual reads as a small inline chip sitting
// close to the text, Material-reference style, rather than a large window.
// aspectRatio still follows REST_WINDOW's ratio since the scale applied in
// useHeroApproachProgress/useHeroScrollProgress is uniform.
const ghostSpanStyle: CSSProperties = {
  display: 'inline-block',
  width: '9vw',
  maxWidth: 150,
  minWidth: 72,
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

const chromeTopLeft: CSSProperties = {
  position: 'absolute',
  left: 'clamp(20px,4vw,56px)',
  top: 96,
  fontSize: 11,
  letterSpacing: '.14em',
  color: COLOR.chromeMuted,
};

const chromeTopRight: CSSProperties = {
  position: 'absolute',
  right: 'clamp(20px,4vw,56px)',
  top: 96,
  fontSize: 11,
  letterSpacing: '.14em',
  color: COLOR.chromeMuted,
};

const chromeBottomLeft: CSSProperties = {
  position: 'absolute',
  left: 'clamp(20px,4vw,56px)',
  bottom: 92,
  fontSize: 11,
  letterSpacing: '.14em',
  color: COLOR.chromeMuted,
};

const progressRailTrack: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  background: COLOR.railTrack,
};

const progressRailFill: CSSProperties = {
  height: '100%',
  width: '0%',
  background: COLOR.brandViolet,
};

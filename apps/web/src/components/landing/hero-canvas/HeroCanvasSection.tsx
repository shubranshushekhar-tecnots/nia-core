'use client';

import { useRef, type CSSProperties, type RefObject } from 'react';
import { CANVAS_BOUNDS, COLOR, CONNECTORS, NODES, REST_WINDOW } from './config';
import { geistMono, geistSans } from './heroCanvasFonts';
import NodeCard from './NodeCard';
import { useHeroScrollProgress } from './useHeroScrollProgress';

// One continuous shot: a small window sits inside the headline showing the
// Supabase node zoomed in; scrolling opens that window until it fills the
// screen, revealing the whole pipeline. The window's dimensions animate —
// the canvas layer inside it (dot grid + node cards + connectors) never
// scales, it only translates to keep the Supabase node's centre under the
// window's centre. See useHeroScrollProgress.ts for the scroll-driven math
// and config.ts for node positions/connector paths.
//
// `heroRef`/`navRef` mirror LandingPage.tsx's existing prop pattern (Nav
// reads this section's bounds to drive its own transparent → solid-black →
// frosted-light theme sweep — see Nav.tsx).
export default function HeroCanvasSection({ heroRef }: { heroRef: RefObject<HTMLElement> }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const railFillRef = useRef<HTMLDivElement>(null);

  useHeroScrollProgress({
    wrapper: heroRef,
    windowEl: windowRef,
    canvasEl: canvasRef,
    textEl: textRef,
    ghostEl: ghostRef,
    chromeEl: chromeRef,
    railFillEl: railFillRef,
  });

  const canvasW = CANVAS_BOUNDS.right - CANVAS_BOUNDS.left;
  const canvasH = CANVAS_BOUNDS.bottom - CANVAS_BOUNDS.top;

  return (
    <section
      ref={heroRef as RefObject<HTMLElement>}
      className={`${geistSans.variable} ${geistMono.variable} nia-hero-canvas-section`}
      style={wrapperStyle}
    >
      <div className="nia-hero-canvas-stage" style={stageStyle}>
        <span aria-hidden="true" style={groundStyle} />

        {/* -------- the window: dimensions animate, position pins after Phase A -------- */}
        <div ref={windowRef} className="nia-hero-window" style={windowBaseStyle}>
          <div ref={canvasRef} style={canvasBaseStyle}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: CANVAS_BOUNDS.left,
                top: CANVAS_BOUNDS.top,
                width: canvasW,
                height: canvasH,
                backgroundImage: `radial-gradient(circle, ${COLOR.dotGrid} 1.2px, transparent 1.2px)`,
                backgroundSize: '28px 28px',
                pointerEvents: 'none',
              }}
            />
            <svg
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: CANVAS_BOUNDS.left,
                top: CANVAS_BOUNDS.top,
                width: canvasW,
                height: canvasH,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
              viewBox={`${CANVAS_BOUNDS.left} ${CANVAS_BOUNDS.top} ${canvasW} ${canvasH}`}
            >
              {CONNECTORS.map((d) => (
                <path key={d} d={d} fill="none" stroke={COLOR.connector} strokeWidth={1.5} strokeLinecap="round" />
              ))}
            </svg>

            {NODES.map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        </div>

        {/* -------- rest-state text: headline, sub, CTAs, bottom-left/right rest chrome --------
            Full-bleed (inset:0, matches the stage) so the fixed-look bottom
            corners below can use `position: absolute` against *this* box
            instead of `position: fixed` against the viewport — a
            `transform` on this element (written by the scroll hook) would
            otherwise become the containing block for any `fixed` descendant
            and silently break their placement. */}
        <div ref={textRef} className="nia-hero-text" style={textLayerStyle}>
          <div style={textInnerStyle}>
            <h1 className={geistSans.className} style={h1Style}>
              <span style={h1Line}>
                <span style={{ color: COLOR.textPrimary }}>Extract. Transform.</span>{' '}
                <span style={{ color: COLOR.brandVioletOnBlack }}>Load.</span>
              </span>
              <span style={h1LineCenter}>
                <span style={{ color: COLOR.textPrimary, justifySelf: 'start' }}>All on one</span>
                <span ref={ghostRef} aria-hidden="true" className="nia-hero-ghost" style={ghostSpanStyle} />
                <span style={{ color: COLOR.textPrimary, justifySelf: 'end' }}>canvas.</span>
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

        {/* -------- full-bleed chrome: fades in once pinned -------- */}
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

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .nia-hero-canvas-section { height: auto !important; }
          .nia-hero-canvas-stage { position: relative !important; height: auto !important; min-height: 100vh; }
        }

        @media (max-width: 768px) {
          .nia-hero-canvas-section { height: auto !important; }
          .nia-hero-canvas-stage { position: relative !important; height: auto !important; padding: 96px 20px 48px; display: flex; flex-direction: column; gap: 28px; }
          .nia-hero-ghost { display: none !important; }
          .nia-hero-text {
            /* In-flow flex item on mobile (headline, then window band
               beneath it) instead of the absolute/inset:0 full-bleed box
               desktop uses so a transform never becomes a containing block
               for the fixed-look corner chrome — those corners are simply
               hidden on mobile instead (below). */
            position: static !important;
            inset: auto !important;
            order: 1;
          }
          .nia-hero-rest-corner { display: none !important; }
          .nia-hero-window {
            position: relative !important;
            left: auto !important; top: auto !important;
            width: 100% !important; height: min(78vw, 420px) !important;
            order: 3;
          }
        }
      `}</style>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Static styles
// ---------------------------------------------------------------------------

const wrapperStyle: CSSProperties = {
  position: 'relative',
  height: '420vh',
  background: COLOR.ground,
};

const stageStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  height: '100vh',
  overflow: 'hidden',
};

const groundStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: COLOR.ground,
};

const windowBaseStyle: CSSProperties = {
  position: 'absolute',
  overflow: 'hidden',
  background: COLOR.canvasBg,
  border: '1px solid #1C1C1C',
  borderRadius: 2,
  willChange: 'width, height, left, top',
  contain: 'layout paint',
  width: REST_WINDOW.w,
  height: REST_WINDOW.h,
};

const canvasBaseStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  willChange: 'transform',
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
// window's rest horizontal position tracks the ghost span's actual live
// position (see useHeroScrollProgress), so it always matches wherever this
// layout puts it.
const h1LineCenter: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'center',
  width: '100%',
  columnGap: 12,
};

const ghostSpanStyle: CSSProperties = {
  display: 'inline-block',
  width: '15vw',
  maxWidth: REST_WINDOW.w,
  minWidth: 64,
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

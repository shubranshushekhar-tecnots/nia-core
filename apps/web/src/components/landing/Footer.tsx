'use client';

import { useEffect, useId, useRef } from 'react';

type ConnectorTab = 's' | 'd';

const SOURCE_LOGOS = [
  { logo: 'postgresql', label: 'PostgreSQL' },
  { logo: 'mysql', label: 'MySQL' },
  { logo: 'sql-server', label: 'SQL Server' },
  { logo: 'mongodb', label: 'MongoDB' },
  { logo: 'oracle', label: 'Oracle' },
  { logo: 'redis', label: 'Redis' },
  { logo: 'amazon-s3', label: 'Amazon S3' },
  { logo: 'salesforce', label: 'Salesforce' },
  { logo: 'hubspot', label: 'HubSpot' },
  { logo: 'stripe', label: 'Stripe' },
];

const DEST_LOGOS = [
  { logo: 'snowflake', label: 'Snowflake' },
  { logo: 'bigquery', label: 'BigQuery' },
  { logo: 'redshift', label: 'Redshift' },
  { logo: 'databricks', label: 'Databricks' },
  { logo: 'google-sheets', label: 'Google Sheets' },
  { logo: 'excel', label: 'Excel Online' },
  { logo: 'power-bi', label: 'Power BI' },
  { logo: 'tableau', label: 'Tableau' },
  { logo: 'looker', label: 'Looker' },
];

const FOOTER_LINKS = [
  { label: 'Canvas', href: '#' },
  { label: 'Connectors', href: '#' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Download agent', href: '#' },
  { label: 'Docs', href: '#' },
  { label: 'Changelog', href: '#' },
  { label: 'Status', href: '#' },
  { label: 'Support', href: '#' },
  { label: 'About', href: '#' },
  { label: 'Careers', href: '#' },
  { label: 'Privacy', href: '#' },
  { label: 'Terms', href: '#' },
];

function MarqueeItem({ logo, label, hidden }: { logo?: string; label: string; hidden?: boolean }) {
  return (
    <span className="nf-it" aria-hidden={hidden ? 'true' : undefined}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/landing/logos/${logo}.svg`} alt="" />
      ) : (
        <span className="nf-pl">PL</span>
      )}
      {label}
    </span>
  );
}

// FOOTER — connector marquee (Sources/Destinations tabs), photo/facts grid,
// legal bar, dot-matrix wordmark. Port of designs/nia-hero/index.html lines
// 479-543, driven by tab/setTab from useNiaHeroEngine instead of the
// reference's own setState (renderVals() lines 775-778, render() lines 802-813).
export default function Footer({ tab, setTab }: { tab: ConnectorTab; setTab: (t: ConnectorTab) => void }) {
  const showSrc = tab !== 'd';
  const uid = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const hotGroupRef = useRef<SVGGElement>(null);
  const spotRef = useRef<SVGRadialGradientElement>(null);

  // Cursor spotlight over the dot-matrix wordmark: dots near the pointer
  // light up indigo with a soft falloff. Pointer position/opacity are
  // eased by hand (not CSS transitions, which jitter on cx/cy) and written
  // straight to the DOM via refs so Footer's own re-renders (tab toggle)
  // never reset mid-gesture — only the constant JSX values below ever
  // reach React's reconciler.
  useEffect(() => {
    const svg = svgRef.current;
    const g = hotGroupRef.current;
    const spot = spotRef.current;
    if (!svg || !g || !spot) return undefined;
    if (window.matchMedia('(hover: none)').matches) return undefined;

    const toPoint = (clientX: number, clientY: number) => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const onMove = (e: PointerEvent) => {
        const p = toPoint(e.clientX, e.clientY);
        if (!p) return;
        spot.setAttribute('cx', String(p.x));
        spot.setAttribute('cy', String(p.y));
      };
      const onEnter = (e: PointerEvent) => {
        onMove(e);
        g.style.opacity = '1';
      };
      const onLeave = () => {
        g.style.opacity = '0';
      };
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerenter', onEnter);
      svg.addEventListener('pointerleave', onLeave);
      return () => {
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerenter', onEnter);
        svg.removeEventListener('pointerleave', onLeave);
      };
    }

    let target = { x: 600, y: 100 };
    const cur = { x: 600, y: 100 };
    let targetOpacity = 0;
    let curOpacity = 0;
    let raf = 0;
    let last = 0;

    const tick = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const kPos = 1 - Math.pow(1 - 0.14, dt * 60);
      const kOp = 1 - Math.pow(1 - 0.08, dt * 60);
      cur.x += (target.x - cur.x) * kPos;
      cur.y += (target.y - cur.y) * kPos;
      curOpacity += (targetOpacity - curOpacity) * kOp;
      spot.setAttribute('cx', cur.x.toFixed(2));
      spot.setAttribute('cy', cur.y.toFixed(2));
      g.style.opacity = curOpacity.toFixed(3);

      const idle =
        targetOpacity === 0 &&
        curOpacity < 0.002 &&
        Math.abs(cur.x - target.x) < 0.05 &&
        Math.abs(cur.y - target.y) < 0.05;
      if (idle) {
        raf = 0;
        last = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const ensureRunning = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const p = toPoint(e.clientX, e.clientY);
      if (!p) return;
      target = { x: p.x, y: p.y };
      ensureRunning();
    };
    const onEnter = (e: PointerEvent) => {
      onMove(e);
      targetOpacity = 1;
      ensureRunning();
    };
    const onLeave = () => {
      targetOpacity = 0;
      ensureRunning();
    };

    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerenter', onEnter);
    svg.addEventListener('pointerleave', onLeave);

    return () => {
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerenter', onEnter);
      svg.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <footer className="nx-foot" style={{ background: '#FFFFFF', color: '#0F172A', padding: '64px max(20px, 4vw) 0', borderTop: '1px solid #E2E8F0' }}>
      <div className="nf-row" style={{ padding: '0 0 28px', alignItems: 'center' }}>
        <div className="nf-l" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <a href="#" aria-label="Nia Core home" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="" width={24} height={24} style={{ display: 'block', width: 24, height: 24 }} />
            <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.02em' }}>Nia Core</span>
          </a>
          <span className="nf-label">60+ connectors · read and write</span>
        </div>
        <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div role="group" aria-label="Connector type" style={{ display: 'inline-flex', alignSelf: 'flex-start', padding: 4, borderRadius: 999, background: '#F1F5F9' }}>
            <button
              type="button"
              aria-pressed={showSrc}
              className="nf-tab"
              onClick={() => setTab('s')}
              style={{ background: showSrc ? '#FFFFFF' : 'transparent', boxShadow: showSrc ? '0 1px 3px rgba(15,23,42,0.12)' : 'none' }}
            >
              Sources
            </button>
            <button
              type="button"
              aria-pressed={!showSrc}
              className="nf-tab"
              onClick={() => setTab('d')}
              style={{ background: !showSrc ? '#FFFFFF' : 'transparent', boxShadow: !showSrc ? '0 1px 3px rgba(15,23,42,0.12)' : 'none' }}
            >
              Destinations
            </button>
          </div>
          <div
            style={{
              overflow: 'hidden',
              WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)',
              maskImage: 'linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)',
            }}
          >
            {showSrc ? (
              <div className="nf-marq">
                {SOURCE_LOGOS.map((l) => (
                  <MarqueeItem key={l.logo} {...l} />
                ))}
                {SOURCE_LOGOS.map((l) => (
                  <MarqueeItem key={`${l.logo}-dup`} {...l} hidden />
                ))}
              </div>
            ) : (
              <div className="nf-marq">
                {DEST_LOGOS.map((l) => (
                  <MarqueeItem key={l.logo} {...l} />
                ))}
                <MarqueeItem label="Planometry" />
                {DEST_LOGOS.map((l) => (
                  <MarqueeItem key={`${l.logo}-dup`} {...l} hidden />
                ))}
                <MarqueeItem label="Planometry" hidden />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="nf-two" style={{ borderTop: '1px solid #E2E8F0', padding: '40px 0 48px' }}>
        <figure style={{ margin: 0, border: '1px solid #E2E8F0', background: '#F7F7F5', boxShadow: '0 18px 40px rgba(15,23,42,0.06)' }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, height: 40, padding: '0 14px',
              borderBottom: '1px solid #E2E8F0', background: '#FFFFFF', fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
              letterSpacing: '0.14em', color: '#64748B',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, background: '#4F46E5' }} />
              CANVAS · TEST WORKFLOW 1
            </span>
            <span>3 NODES · 2 EDGES · READY</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/canvas.webp"
            alt="Nia Core canvas: a SQL source, a transform and a Planometry destination connected in one workflow"
            width={1400}
            height={473}
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
          <figcaption style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14, borderTop: '1px solid #E2E8F0', background: '#FFFFFF' }}>
            <span style={{ fontSize: 14, color: '#475569' }}>Source, rules and destination. Drawn once, run on schedule.</span>
            <a href="#" className="nt nt-cta" style={{ height: 32 }}>Open canvas</a>
          </figcaption>
        </figure>
        <div className="nf-facts">
          <div className="nf-fact">
            <span className="nf-label">Security</span>
            <span className="nf-v">Credentials encrypted</span>
            <span className="nf-v">Workspaces kept separate</span>
            <span className="nf-v">20% delete guard on every run</span>
          </div>
          <div className="nf-fact">
            <span className="nf-label">Sync</span>
            <span className="nf-v">On demand or on a schedule</span>
            <span className="nf-v">Incremental after the first run</span>
          </div>
          <div className="nf-fact">
            <span className="nf-label">Plans</span>
            <span className="nf-v">Free · Pro $19 · Organization $99</span>
            <a href="#pricing" style={{ fontSize: 14, color: '#4F46E5', textDecoration: 'none' }}>See pricing →</a>
          </div>
          <div className="nf-fact">
            <span className="nf-label">Agent runs on</span>
            <span className="nf-v">Windows / macOS / Linux</span>
            <span className="nf-v">Outbound only · one-time pairing code</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '14px 28px', padding: '20px 0', borderTop: '1px solid #E2E8F0' }}>
        <span className="nf-legal">© 2026 Nia Core · Rows moved responsibly</span>
        <nav aria-label="Footer" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 22px' }}>
          {FOOTER_LINKS.map((l) => (
            <a key={l.label} href={l.href} className="nf-legal">{l.label}</a>
          ))}
        </nav>
        <span className="nf-legal">A failed run is never metered</span>
      </div>

      <svg ref={svgRef} viewBox="0 0 1200 200" width="100%" style={{ display: 'block', margin: '8px 0 24px' }} aria-hidden="true">
        <defs>
          <pattern id="nf-dots" width={6} height={6} patternUnits="userSpaceOnUse">
            <circle cx={3} cy={3} r={1.35} fill="#94A3B8" />
          </pattern>
          <pattern id={`nf-dots-hot-${uid}`} width={6} height={6} patternUnits="userSpaceOnUse">
            <circle cx={3} cy={3} r={1.6} fill="#4F46E5" />
          </pattern>
          <radialGradient ref={spotRef} id={`nf-spot-${uid}`} gradientUnits="userSpaceOnUse" cx={600} cy={100} r={170}>
            <stop offset="0" stopColor="#fff" stopOpacity={1} />
            <stop offset=".45" stopColor="#fff" stopOpacity={0.75} />
            <stop offset="1" stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <mask id={`nf-mask-${uid}`} maskUnits="userSpaceOnUse" x={0} y={0} width={1200} height={200}>
            <rect width={1200} height={200} fill={`url(#nf-spot-${uid})`} />
          </mask>
        </defs>
        <text
          x={600}
          y={178}
          textAnchor="middle"
          fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif"
          fontWeight={700}
          fontSize={232}
          letterSpacing={-4}
          textLength={1190}
          lengthAdjust="spacingAndGlyphs"
          fill="url(#nf-dots)"
        >
          NIA CORE
        </text>
        <g ref={hotGroupRef} mask={`url(#nf-mask-${uid})`} style={{ opacity: 0 }}>
          <text
            x={600}
            y={178}
            textAnchor="middle"
            fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif"
            fontWeight={700}
            fontSize={232}
            letterSpacing={-4}
            textLength={1190}
            lengthAdjust="spacingAndGlyphs"
            fill={`url(#nf-dots-hot-${uid})`}
          >
            NIA CORE
          </text>
        </g>
      </svg>
    </footer>
  );
}

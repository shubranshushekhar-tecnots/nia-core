import type { CSSProperties, RefObject } from 'react';
import { plexSans } from './heroFonts';
import HeroDiagram from './HeroDiagram';
import { ghostBtnLg } from './styles';

// Light two-column hero: copy on the left, the interactive "lifecycle loop"
// diagram on the right. Nav is a separate sibling in LandingPage.tsx (not
// nested here) so its `position:sticky` keeps working; visual overlap with
// this hero is achieved via Nav's own negative margin-bottom, not by nesting.
export default function Hero({ heroRef }: { heroRef: RefObject<HTMLElement> }) {
  return (
    <section ref={heroRef} className={plexSans.variable} style={heroSection}>
      <span aria-hidden="true" style={dotGrid} />

      <div style={heroInner} className="nia-hero-inner">
        <div style={heroTextCol}>
          <h1 style={headline}>
            <span>
              {/* Single brand accent (--primary) on the final word, not a
                  three-hue rainbow — reads as confident/enterprise-grade
                  and ties back to the indigo "Start free" CTA below rather
                  than competing with it. */}
              <span style={{ color: 'var(--text)' }}>Extract. Transform.</span>{' '}
              <span style={{ color: 'var(--primary)' }}>Load.</span>
            </span>
            <span style={headlineMuted}>All on one canvas you can watch.</span>
          </h1>

          <p style={subCopy}>
            Draw the ETL pipeline, schedule it, and wake up to dashboards that filled themselves.
          </p>

          <div style={ctaRow}>
            <a href="/signup" className="nia-hero-cta-primary" style={primaryCta}>
              Start free
            </a>
            <a href="#product" className="nia-hero-cta-secondary" style={{ ...ghostBtnLg, textDecoration: 'none' }}>
              Watch a 2-min run
            </a>
          </div>
        </div>

        <div style={heroDiagramCol}>
          <HeroDiagram />
        </div>
      </div>

      <style>{`
        .nia-hero-cta-primary:hover { transform: translateY(-1px); box-shadow: 0 14px 28px -16px rgba(79,70,229,.6); }
        .nia-hero-cta-secondary:hover { border-color: var(--line-strong); }
        @media (max-width: 900px) {
          .nia-hero-inner { flex-direction: column; }
        }
      `}</style>
    </section>
  );
}

const heroSection: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  boxSizing: 'border-box',
  background: 'var(--bg)',
};

const dotGrid: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundImage: 'radial-gradient(circle, #E7ECF3 1px, transparent 1px)',
  backgroundSize: '20px 20px',
  WebkitMaskImage: 'radial-gradient(75% 60% at 50% 35%, #000 0%, transparent 78%)',
  maskImage: 'radial-gradient(75% 60% at 50% 35%, #000 0%, transparent 78%)',
  pointerEvents: 'none',
};

const heroInner: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  boxSizing: 'border-box',
  maxWidth: 1480,
  margin: '0 auto',
  padding: '148px clamp(24px,6vw,88px) 96px',
  display: 'flex',
  alignItems: 'center',
  gap: 48,
  fontFamily: 'var(--font-plex-sans)',
};

const heroTextCol: CSSProperties = {
  flex: '1 1 420px',
  minWidth: 320,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  textAlign: 'left',
};

const heroDiagramCol: CSSProperties = {
  flex: '1 1 680px',
  minWidth: 0,
  maxWidth: 840,
  width: '100%',
};

const headline: CSSProperties = {
  margin: 0,
  fontWeight: 600,
  fontSize: 'clamp(36px,4.6vw,60px)',
  lineHeight: 1.08,
  letterSpacing: '-.03em',
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const headlineMuted: CSSProperties = {
  color: 'var(--muted)',
  fontSize: '.62em',
  fontWeight: 500,
};

const subCopy: CSSProperties = {
  margin: '22px 0 0',
  maxWidth: 460,
  fontSize: 'clamp(15px,1.2vw,17px)',
  lineHeight: 1.6,
  color: 'var(--secondary)',
};

const ctaRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 32,
};

const primaryCta: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 44,
  padding: '0 24px',
  borderRadius: 11,
  background: 'var(--primary)',
  color: '#fff',
  fontWeight: 600,
  fontSize: 14.5,
  textDecoration: 'none',
  boxShadow: '0 10px 22px -12px rgba(79,70,229,.8)',
  transition: 'transform .15s ease, box-shadow .15s ease',
};

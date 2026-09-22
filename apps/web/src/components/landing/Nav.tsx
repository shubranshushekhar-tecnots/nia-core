import type { RefObject } from 'react';
import Logo from '@/components/Logo';
import { hlFontFamily } from './hairline/styles';

// Sits above the hero, which is now a dark island (hero-canvas/
// HeroCanvasSection): Nav starts transparent-on-black, goes solid black
// while the hero is pinned, then resumes the normal frosted-light surface
// once scrolled past it — driven by the CSS custom properties --nav-bg/
// --nav-blur/--nav-fg that LandingPage.tsx's onScroll handler sets
// imperatively. --nav-fg is only set while over the dark hero (falls back
// to var(--text)/var(--secondary) once removed past the hero), and is
// threaded into Logo's wordmarkColor prop so the mark and nav links re-skin
// together with no other prop plumbing. Stays a DOM sibling of the hero
// (not nested) so `position:sticky` isn't broken by the hero's own
// scroll-driven styles; the negative marginBottom here pulls the hero up
// underneath this nav's box instead, relying on Nav's z-index (50) for
// correct paint order.
//
// NAV_HEIGHT must equal this nav's real rendered height (22px padding top
// + 22px padding bottom + the 35px content row, from the "Start free"
// button's height:34 line) — LandingPage.tsx's `pastHero` scroll threshold
// also imports this constant so the hero/next-section hard content
// boundary always lands fully behind Nav's opaque/pinned phase instead of
// inside its translucent frosted phase (a mismatch here previously left a
// thin gap where hero's black and the next section's light background
// showed a visible seam through Nav's blur).
export const NAV_HEIGHT = 79;

export default function Nav({ navRef }: { navRef: RefObject<HTMLElement> }) {
  return (
    <nav
      ref={navRef}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        boxSizing: 'border-box',
        marginBottom: -NAV_HEIGHT,
        padding: '22px clamp(20px,4vw,56px)',
        background: 'var(--nav-bg, transparent)',
        backdropFilter: 'var(--nav-blur, none)',
        WebkitBackdropFilter: 'var(--nav-blur, none)',
        borderBottom: '1px solid transparent',
        transition: 'background .2s ease, backdrop-filter .2s ease, border-color .2s ease, box-shadow .2s ease',
        fontFamily: hlFontFamily,
      }}
    >
      <div
        style={{
          maxWidth: 1440,
          margin: '0 auto',
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <div className="nia-nav-logo" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={26} wordmarkColor="var(--nav-fg, var(--text))" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <a href="#product" className="nia-nav-link" style={navLinkStyle}>Product</a>
          <a href="#pricing" className="nia-nav-link" style={navLinkStyle}>Pricing</a>
          <a href="#connectors" className="nia-nav-link" style={navLinkStyle}>Docs</a>
          <a href="#stats" className="nia-nav-link" style={navLinkStyle}>Changelog</a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16 }}>
          <a href="/login" className="nia-nav-link" style={navLinkStyle}>Sign in</a>
          <a
            href="/signup"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 34,
              padding: '0 15px',
              borderRadius: 0,
              fontSize: 13.5,
              fontWeight: 600,
              color: '#07090c',
              background: '#e8ecf1',
            }}
          >
            Start free
          </a>
        </div>
      </div>

      <style>{`
        .nia-nav-link { color: var(--nav-fg, var(--secondary)); transition: color .2s ease; }
        .nia-nav-link:hover { color: var(--nav-fg, var(--text)); }
        .nia-nav-logo * { transition: color .2s ease; }
      `}</style>
    </nav>
  );
}

const navLinkStyle = {
  fontSize: 14.5,
  fontWeight: 500,
  textDecoration: 'none',
} as const;

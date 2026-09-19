import type { RefObject } from 'react';
import Logo from '@/components/Logo';
import { plexSans } from './heroFonts';

// Sits above the (now light) hero, transparent at first and morphing to a
// frosted surface once scrolled past it — driven by the CSS custom
// properties --nav-bg/--nav-blur that LandingPage.tsx's onScroll handler
// sets imperatively. Text stays a constant dark color throughout (the hero
// behind it is light in both states now), so it's hardcoded here rather
// than routed through a --nav-fg custom property. Stays a DOM sibling of
// Hero (not nested) so `position:sticky` isn't broken by Hero's
// scroll-driven `transform`; the negative marginBottom here pulls Hero up
// underneath this nav's box instead, relying on Nav's z-index (50) for
// correct paint order.
export default function Nav({ navRef }: { navRef: RefObject<HTMLElement> }) {
  return (
    <nav
      ref={navRef}
      className={plexSans.variable}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        boxSizing: 'border-box',
        marginBottom: -74,
        padding: '22px clamp(20px,4vw,56px)',
        background: 'var(--nav-bg, transparent)',
        backdropFilter: 'var(--nav-blur, none)',
        WebkitBackdropFilter: 'var(--nav-blur, none)',
        borderBottom: '1px solid transparent',
        transition: 'background .2s ease, backdrop-filter .2s ease, border-color .2s ease, box-shadow .2s ease',
        fontFamily: 'var(--font-plex-sans)',
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
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={26} />
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
              borderRadius: 8,
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
        .nia-nav-link { color: var(--secondary); transition: color .15s ease; }
        .nia-nav-link:hover { color: var(--text); }
      `}</style>
    </nav>
  );
}

const navLinkStyle = {
  fontSize: 14.5,
  fontWeight: 500,
  textDecoration: 'none',
} as const;

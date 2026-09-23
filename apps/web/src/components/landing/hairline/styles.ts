// Type scale for the "hairline" design system (Connectors + Pricing
// sections), ported verbatim from designs/Connectors — full page-html/
// Connectors.dc.html and designs/Pricing — full page-html/Pricing.dc.html.
// Values only apply inside a `.hl-scope` wrapper (see theme.css) — this is
// a deliberately separate visual language from the rest of the landing
// page's indigo theme, not a reuse of Hero/Stats/etc.'s type scale.
import type { CSSProperties } from 'react';

// The hairline system's font stack (`.hl-scope` in theme.css) — exported
// here too so Nav and the Hero headline can use the exact same stack
// without joining `.hl-scope` (which also carries unrelated --hl-* color
// tokens neither of those owns). Keeps the whole landing page on one
// font family: 8 of 10 sections were already `.hl-scope`; Nav previously
// used IBM Plex Sans and the Hero headline used Geist Sans — both now
// match this instead.
export const hlFontFamily = '"Helvetica Neue", Helvetica, Archivo, "Segoe UI", Arial, sans-serif';

export const pageH1: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(38px,5.6vw,80px)',
  lineHeight: 1.075, // 86/80
  fontWeight: 300,
  letterSpacing: '-.018em',
  color: 'var(--hl-ink)',
};

export const sectionH2: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(32px,4vw,56px)',
  lineHeight: 1.107, // 62/56
  fontWeight: 300,
  letterSpacing: '-.018em',
  color: 'var(--hl-ink)',
};

export const bandH2: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(32px,4.4vw,64px)',
  lineHeight: 1.094, // 70/64
  fontWeight: 300,
  letterSpacing: '-.018em',
  color: '#ffffff',
};

export const priceStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(44px,4.4vw,64px)',
  lineHeight: 1.0625, // 68/64
  fontWeight: 300,
  letterSpacing: '-.02em',
  color: 'var(--hl-ink)',
};

export const statFigure: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(36px,4vw,56px)',
  lineHeight: 1.071, // 60/56
  fontWeight: 300,
  letterSpacing: '-.02em',
  color: 'var(--hl-ink)',
};

export const cardTitle: CSSProperties = {
  margin: 0,
  fontSize: 28,
  lineHeight: '36px',
  fontWeight: 500,
  letterSpacing: '-.01em',
  color: 'var(--hl-ink)',
};

// Font-size/line-height for this scale live in the `.hl-lead` CSS class
// (theme.css), not here — it steps down to 16px/26px below 640px, and a
// CSS class lets consuming sections (e.g. ConnectorsOrbit) stay server
// components instead of needing a matchMedia hook.
export const leadStyle: CSSProperties = {
  margin: 0,
  fontWeight: 400,
  color: 'var(--hl-ink-2)',
};

export const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: '24px',
  fontWeight: 400,
  color: 'var(--hl-ink-2)',
};

// Uppercase set here in CSS, never in the copy string passed to <Eyebrow>.
export const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  letterSpacing: '.16em',
  textTransform: 'uppercase',
  color: 'var(--hl-ink-3)',
};

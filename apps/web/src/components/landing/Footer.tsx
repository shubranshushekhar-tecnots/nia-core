import type { RefObject } from 'react';

const FOOTER_COLS = [
  { title: 'PRODUCT', links: [{ label: 'Canvas', href: '#product' }, { label: 'Connectors', href: '#connectors' }, { label: 'Pricing', href: '#pricing' }, { label: 'Sign in', href: '/login' }] },
  { title: 'RESOURCES', links: [{ label: 'Docs', href: '#product' }, { label: 'Changelog', href: '#stats' }, { label: 'Status', href: '#stats' }, { label: 'Support', href: '#connectors' }] },
  { title: 'COMPANY', links: [{ label: 'About', href: '#product' }, { label: 'Careers', href: '#product' }, { label: 'Privacy', href: '#product' }, { label: 'Terms', href: '#product' }] },
];

export default function Footer({ footRef }: { footRef: RefObject<HTMLElement> }) {
  return (
    <footer
      ref={footRef}
      style={{
        position: 'relative',
        zIndex: 2,
        maxWidth: 1260,
        margin: '-40px auto 0',
        boxSizing: 'border-box',
        padding: '84px 34px 48px',
        background: 'var(--bg)',
        borderRadius: '36px 36px 0 0',
        boxShadow: '0 -30px 60px -34px rgba(79,70,229,.3)',
        willChange: 'transform',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
        gap: 28,
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: 'linear-gradient(145deg,#6366F1,#4338CA)', color: '#FFFFFF', fontSize: 13, fontWeight: 700 }}>N</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Nia Core</span>
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>© 2026 Nia Core. Rows moved responsibly.</span>
      </div>
      {FOOTER_COLS.map((c) => (
        <div key={c.title} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', color: 'var(--muted)' }}>{c.title}</span>
          {c.links.map((l) => (
            <a key={l.label} href={l.href} style={{ fontSize: 13, color: 'var(--secondary)' }}>{l.label}</a>
          ))}
        </div>
      ))}
    </footer>
  );
}

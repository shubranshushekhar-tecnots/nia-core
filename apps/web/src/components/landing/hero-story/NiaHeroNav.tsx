'use client';

import { useEffect } from 'react';

const LINKS = [
  { href: '#pricing', label: 'Pricing' },
  { href: '/docs/agent', label: 'Docs' },
  { href: '/downloads', label: 'Agent' },
  { href: '/login', label: 'Sign in' },
];

function ArrowIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3 9h12M10 4l5 5-5 5" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

// NAV — single header that switches theme via [data-theme] (see
// useNiaHeroEngine's navLight, which flips it dark→light just past the
// black hero). Port of designs/nia-hero/index.html lines 400-414, plus the
// hover-indicator sliding-box logic from componentDidMount (lines 571-589).
export default function NiaHeroNav() {
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const t = target?.closest?.('.nt-nav .nt') as HTMLElement | null;
      const navs = document.querySelectorAll<HTMLElement>('.nt-nav');
      navs.forEach((n) => {
        const ind = n.querySelector<HTMLElement>('.nt-ind');
        if (!ind) return;
        if (t && n.contains(t)) {
          const nr = n.getBoundingClientRect();
          const r = t.getBoundingClientRect();
          if (ind.style.opacity !== '1') {
            ind.style.transition = 'none';
            ind.style.transform = `translateX(${r.left - nr.left}px)`;
            ind.style.width = `${r.width}px`;
            void ind.offsetWidth;
            ind.style.transition = '';
          }
          ind.style.transform = `translateX(${r.left - nr.left}px)`;
          ind.style.width = `${r.width}px`;
          ind.style.opacity = '1';
        } else if (!target?.closest || !n.contains(target)) {
          ind.style.opacity = '0';
        }
      });
    };
    document.addEventListener('mouseover', handleMouseOver);
    return () => document.removeEventListener('mouseover', handleMouseOver);
  }, []);

  return (
    <header
      className="nia-nav"
      data-theme="dark"
      style={{
        position: 'fixed', left: 0, right: 0, top: 0, zIndex: 20, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 24, height: 56, boxSizing: 'border-box', padding: '0 max(20px, 3vw)',
      }}
    >
      <a
        href="#"
        aria-label="Nia Core home"
        className="nt"
        style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', height: 34, padding: '0 14px 0 6px', textTransform: 'none', letterSpacing: 0 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" width={24} height={24} style={{ display: 'block', width: 24, height: 24 }} />
        <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.02em' }}>Nia Core</span>
      </a>
      <nav className="nt-row nt-nav" aria-label="Main">
        <span className="nt-ind" />
        <span className="nx-links nt-row">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} className="nt">{l.label}</a>
          ))}
        </span>
        <a href="/signup" className="nt nt-cta">Start free</a>
        <a href="/signup" className="nt nt-arr" aria-label="Start free"><ArrowIcon /></a>
      </nav>
    </header>
  );
}

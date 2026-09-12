'use client';

import { useState } from 'react';
import type { MouseEvent } from 'react';
import Reveal from './Reveal';
import { recPillStyle } from './styles';

const APP = 'Nia Core Shell.dc.html';

const PLANS = [
  { id: 'free', num: '01', name: 'Free', price: '$0', unit: '/ month', aura: '#DDD6FE', check: '#7C3AED', cta: 'Start free', recommended: false, features: ['1 project', '2 workflows', '100k rows per run', 'Community support'] },
  { id: 'pro', num: '02', name: 'Pro', price: '$19', unit: '/ month', aura: '#A5F3FC', check: '#0891B2', cta: 'Start with Pro', recommended: false, features: ['10 projects', '25 workflows', '1M rows per run', 'Email support'] },
  { id: 'org', num: '03', name: 'Organization', price: '$99', unit: '/ month', aura: '#FBCFE8', check: '#4F46E5', cta: 'Start with your team', recommended: true, features: ['Seats and roles', 'Unlimited projects and workflows', '50M rows per run', 'SSO and activity log'] },
] as const;

type Tilt = { id: string; rx: number; ry: number; gx: number; gy: number };

export default function Pricing() {
  const [hovered, setHovered] = useState<string | null>(null);
  const [tilt, setTilt] = useState<Tilt | null>(null);

  const handleTilt = (id: string) => (e: MouseEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setTilt({ id, rx: (0.5 - py) * 16, ry: (px - 0.5) * 16, gx: Math.round(px * 100), gy: Math.round(py * 100) });
  };

  return (
    <section id="pricing" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0' }}>
      <Reveal as="h2" style={{ margin: '0 0 24px', fontSize: 'clamp(28px,4vw,38px)', fontWeight: 700, letterSpacing: '-.03em' }}>
        Start free. Upgrade when the rows do.
      </Reveal>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 18, perspective: 1200 }}>
        {PLANS.map((p) => {
          const hov = hovered === p.id;
          const tl = tilt && tilt.id === p.id ? tilt : null;
          return (
            <Reveal
              key={p.id}
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => {
                setHovered((cur) => (cur === p.id ? null : cur));
                setTilt(null);
              }}
              onMouseMove={handleTilt(p.id)}
              style={{
                position: 'relative',
                overflow: 'hidden',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 380,
                padding: '24px 22px',
                borderRadius: 20,
                transformStyle: 'preserve-3d',
                transform: tl
                  ? `rotateX(${tl.rx.toFixed(2)}deg) rotateY(${tl.ry.toFixed(2)}deg) translateY(-4px)`
                  : hov
                    ? 'translateY(-4px)'
                    : 'none',
                transition: 'transform .2s cubic-bezier(.2,.7,.2,1), box-shadow .22s ease',
                background: 'linear-gradient(165deg,rgba(255,255,255,.78),rgba(255,255,255,.56))',
                backdropFilter: 'blur(16px) saturate(1.6)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.6)',
                border: p.recommended ? '1.5px solid var(--primary)' : '1px solid rgba(255,255,255,.85)',
                outline: '1px solid rgba(203,213,225,.5)',
                boxShadow: `0 2px 6px rgba(15,23,42,.05),${hov ? '0 28px 52px -18px rgba(79,70,229,.28)' : '0 16px 36px -18px rgba(79,70,229,.2)'},inset 0 1px 0 rgba(255,255,255,.9)`,
              }}
            >
              <span aria-hidden="true" style={{ position: 'absolute', right: -70, top: -80, width: 300, height: 300, borderRadius: '50%', background: `radial-gradient(circle,${p.aura},transparent 70%)`, opacity: 0.5, pointerEvents: 'none' }} />
              <span
                aria-hidden="true"
                style={
                  tl
                    ? { position: 'absolute', inset: 0, pointerEvents: 'none', mixBlendMode: 'soft-light', background: `radial-gradient(300px circle at ${tl.gx}% ${tl.gy}%,rgba(255,255,255,.55),transparent 42%)` }
                    : { display: 'none' }
                }
              />
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{p.num}</span>
                <span style={{ flex: 1 }} />
                {p.recommended && <span style={recPillStyle}>RECOMMENDED</span>}
              </div>
              <span style={{ position: 'relative', marginTop: 10, fontSize: 19, fontWeight: 700 }}>{p.name}</span>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
                <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-.03em' }}>{p.price}</span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{p.unit}</span>
              </div>
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10, margin: '18px 0 20px' }}>
                {p.features.map((text) => (
                  <span key={text} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--secondary)' }}>
                    <span style={{ flex: 'none', width: 19, height: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', fontSize: 10, background: `${p.check}1F`, color: p.check }}>✓</span>
                    {text}
                  </span>
                ))}
              </div>
              <a
                href={APP}
                style={{
                  position: 'relative',
                  marginTop: 'auto',
                  width: '100%',
                  boxSizing: 'border-box',
                  height: 46,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 12,
                  fontSize: 14.5,
                  fontWeight: 600,
                  ...(p.recommended
                    ? { background: 'linear-gradient(120deg,#4F46E5,#7C3AED)', color: '#FFFFFF', boxShadow: '0 14px 28px -14px rgba(79,70,229,.8)' }
                    : { background: 'var(--surface)', color: 'var(--secondary)', border: '1px solid var(--line)' }),
                }}
              >
                {p.cta}
              </a>
            </Reveal>
          );
        })}
      </div>
      <Reveal as="p" style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--muted)' }}>
        All plans are monthly. No run-based surprise bills — rows per run are the only meter.
      </Reveal>
    </section>
  );
}

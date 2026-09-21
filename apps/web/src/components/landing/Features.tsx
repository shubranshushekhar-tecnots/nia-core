'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import Reveal from './Reveal';

const FEATURES = [
  { num: '01', key: 'a', aura: '#A5F3FC', title: 'A canvas that runs', body: 'Drag sources, transforms and destinations onto a grid, connect them, and press run. No YAML, no cron files.' },
  { num: '02', key: 'b', aura: '#DDD6FE', title: 'Every source, one grid', body: 'Databases, warehouses, files and BI tools connect once and appear as reusable handles in every pipeline.' },
  { num: '03', key: 'c', aura: '#FBCFE8', title: 'AI on the canvas', body: 'Ask for a pipeline in words, or drop an AI step in to classify and extract fields mid-flow.' },
] as const;

const ART: Record<string, CSSProperties[]> = {
  a: [0, 1, 2, 3, 4].map((i) => ({
    position: 'absolute',
    right: 4 + i * 16,
    top: 14 + i * 4,
    width: 52,
    height: 104,
    borderRadius: 12,
    transform: 'skewY(-10deg)',
    background: 'linear-gradient(160deg,rgba(165,243,252,.85),rgba(199,210,254,.82),rgba(251,207,232,.85))',
    filter: `hue-rotate(${-70 + i * 35}deg)`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9),0 8px 18px -10px rgba(79,70,229,.5)',
  })),
  b: [
    {
      position: 'absolute',
      right: 26,
      top: 24,
      width: 96,
      height: 124,
      borderRadius: 12,
      transform: 'rotate(-9deg)',
      background: 'linear-gradient(165deg,#FFFFFF,#EDE9FE)',
      boxShadow: '0 14px 26px -16px rgba(15,23,42,.4),inset 0 14px 0 -12px rgba(148,163,184,.35),inset 0 30px 0 -28px rgba(148,163,184,.3)',
    },
  ],
  c: [
    {
      position: 'absolute',
      right: 22,
      top: 26,
      width: 112,
      height: 112,
      borderRadius: '50%',
      background: 'radial-gradient(circle at 32% 28%,#FFFFFF,#FBCFE8 34%,#C7D2FE 62%,#A7F3D0 100%)',
      boxShadow: 'inset -8px -10px 22px rgba(79,70,229,.28),0 16px 30px -14px rgba(124,58,237,.5)',
    },
    { position: 'absolute', right: 8, top: 14, width: 12, height: 12, borderRadius: '50%', background: 'linear-gradient(160deg,#C7D2FE,#A7F3D0)' },
    { position: 'absolute', right: 132, top: 112, width: 10, height: 10, borderRadius: '50%', background: 'linear-gradient(160deg,#FBCFE8,#C7D2FE)' },
  ],
};

export default function Features() {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <section id="product" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0' }}>
      <Reveal as="h2" style={{ margin: '0 0 26px', maxWidth: 600, fontSize: 'clamp(28px,4vw,38px)', fontWeight: 700, letterSpacing: '-.03em' }}>
        Pipelines you draw, not scripts you babysit
      </Reveal>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 18 }}>
        {FEATURES.map((f) => {
          const hov = hovered === f.key;
          return (
            <Reveal
              key={f.key}
              onMouseEnter={() => setHovered(f.key)}
              onMouseLeave={() => setHovered((cur) => (cur === f.key ? null : cur))}
              style={{
                position: 'relative',
                overflow: 'hidden',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 290,
                padding: '24px 22px',
                borderRadius: 20,
                background: 'linear-gradient(165deg,rgba(255,255,255,.75),rgba(255,255,255,.55))',
                backdropFilter: 'blur(14px) saturate(1.5)',
                WebkitBackdropFilter: 'blur(14px) saturate(1.5)',
                border: '1px solid rgba(255,255,255,.85)',
                outline: '1px solid rgba(203,213,225,.5)',
                boxShadow: `0 2px 6px rgba(15,23,42,.05),${hov ? '0 26px 48px -20px rgba(79,70,229,.3)' : '0 16px 36px -20px rgba(79,70,229,.2)'}`,
                transform: `translateY(${hov ? -4 : 0}px)`,
                transition: 'transform .22s cubic-bezier(.2,.7,.2,1), box-shadow .22s ease',
              }}
            >
              <span aria-hidden="true" style={{ position: 'absolute', right: -70, top: -80, width: 280, height: 280, borderRadius: '50%', background: `radial-gradient(circle,${f.aura},transparent 70%)`, opacity: 0.5, pointerEvents: 'none' }} />
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: -6,
                  bottom: -10,
                  width: 170,
                  height: 170,
                  pointerEvents: 'none',
                  transform: `scale(${hov ? 1.04 : 1})`,
                  transition: 'transform .24s cubic-bezier(.2,.7,.2,1)',
                }}
              >
                {ART[f.key]!.map((pieceStyle, i) => (
                  <span key={i} style={pieceStyle} />
                ))}
              </span>
              <span style={{ position: 'relative', fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{f.num}</span>
              <span style={{ position: 'relative', marginTop: 8, fontSize: 19, fontWeight: 700, letterSpacing: '-.02em' }}>{f.title}</span>
              <span style={{ position: 'relative', marginTop: 8, maxWidth: '24ch', fontSize: 13.5, lineHeight: 1.6, color: 'var(--secondary)' }}>{f.body}</span>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

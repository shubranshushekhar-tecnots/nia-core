import type { RefObject } from 'react';
import Reveal from './Reveal';
import { demoFrameStyle, rail, tile } from './styles';

type DemoNode = {
  id: string;
  name: string;
  mono: string;
  type: string;
  c: string;
  t: string;
  x: number;
  y: number;
};

const DN: DemoNode[] = [
  { id: 'a', name: 'Every night 02:00', mono: '⚡', type: 'TRIGGER', c: 'var(--c-trigger)', t: 'rgba(79,70,229,.10)', x: 24, y: 40 },
  { id: 'b', name: '@mysql-sales', mono: 'My', type: 'DATA', c: 'var(--c-data)', t: 'rgba(8,145,178,.10)', x: 24, y: 170 },
  { id: 'c', name: 'Transform', mono: 'ƒ', type: 'ACTION', c: 'var(--c-action)', t: 'rgba(37,99,235,.10)', x: 270, y: 104 },
  { id: 'd', name: 'New rows?', mono: '◇', type: 'CONDITION', c: 'var(--c-condition)', t: 'rgba(124,58,237,.10)', x: 508, y: 40 },
  { id: 'e', name: '@powerbi-sales', mono: 'BI', type: 'ACTION', c: 'var(--c-action)', t: 'rgba(37,99,235,.10)', x: 508, y: 180 },
];
const NW = 208;
const NH = 64;
const EDGES: [string, string][] = [['a', 'c'], ['b', 'c'], ['c', 'd'], ['c', 'e']];
const byId = (id: string) => DN.find((n) => n.id === id)!;

export default function DemoSection({ stageRef }: { stageRef: RefObject<HTMLElement> }) {
  return (
    <section
      id="product"
      ref={stageRef}
      style={{
        position: 'relative',
        zIndex: 2,
        maxWidth: 1260,
        margin: '-44px auto 0',
        boxSizing: 'border-box',
        padding: '88px 24px 8px',
        background: 'var(--bg)',
        borderRadius: '36px 36px 0 0',
        boxShadow: '0 -30px 60px -34px rgba(79,70,229,.35)',
        willChange: 'transform, opacity',
      }}
    >
      <Reveal style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(28px,4vw,38px)', fontWeight: 700, letterSpacing: '-.03em' }}>Watch a pipeline run itself</h2>
      </Reveal>
      <Reveal style={demoFrameStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '11px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#F87171' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#FBBF24' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#34D399' }} />
          <span style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--muted)' }}>nia.app / sales-analysis</span>
        </div>
        <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', backgroundImage: 'radial-gradient(circle,#E7ECF3 1px,transparent 1px)', backgroundSize: '20px 20px' }}>
          <div style={{ position: 'relative', width: 716, maxWidth: '100%', height: 300 }}>
            <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
              <defs>
                {EDGES.map(([a, b], i) => {
                  const A = byId(a);
                  const B = byId(b);
                  return (
                    <linearGradient key={`g${i}`} id={`ldg${i}`} gradientUnits="userSpaceOnUse" x1={A.x + NW} y1={A.y + NH / 2} x2={B.x} y2={B.y + NH / 2}>
                      <stop offset="0%" stopColor={A.c} />
                      <stop offset="100%" stopColor={B.c} />
                    </linearGradient>
                  );
                })}
              </defs>
              {EDGES.map(([a, b], i) => {
                const A = byId(a);
                const B = byId(b);
                const p1 = { x: A.x + NW, y: A.y + NH / 2 };
                const p2 = { x: B.x, y: B.y + NH / 2 };
                const d = Math.max(40, (p2.x - p1.x) * 0.5);
                return (
                  <path
                    key={`e${i}`}
                    d={`M ${p1.x},${p1.y} C ${p1.x + d},${p1.y} ${p2.x - d},${p2.y} ${p2.x},${p2.y}`}
                    fill="none"
                    stroke={`url(#ldg${i})`}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeDasharray="7 9"
                    style={{ animation: 'edgeFlow .7s linear infinite' }}
                  />
                );
              })}
            </svg>
            {DN.map((n) => (
              <div
                key={n.id}
                style={{
                  position: 'absolute',
                  overflow: 'hidden',
                  left: n.x,
                  top: n.y,
                  width: NW,
                  boxSizing: 'border-box',
                  padding: '14px 14px 12px',
                  borderRadius: 14,
                  background: 'linear-gradient(180deg,#FFFFFF,#FAFBFE)',
                  border: '1px solid rgba(226,232,240,.9)',
                  boxShadow: `0 1px 2px rgba(15,23,42,.05),0 12px 26px -18px color-mix(in srgb, ${n.c} 40%, transparent)`,
                }}
              >
                <span style={rail(n.c)} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={tile(n.c, n.t)}>{n.mono}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                  <span style={{ flex: 'none', fontSize: 9.5, fontWeight: 700, letterSpacing: '.08em', color: n.c }}>{n.type}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '12px 16px', borderTop: '1px solid var(--line)', fontSize: 12.5, color: 'var(--secondary)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} />
          Run succeeded · 1.28M rows · 1m 04s · every night while you sleep.
        </div>
      </Reveal>
    </section>
  );
}

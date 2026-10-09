import { cssVar } from '../cssVar';

// 02 · TRANSFORM — the fibre: a dotted pulse travels along an SVG path past
// three gated node cards (source → filter → incremental sync). Port of
// designs/nia-hero/index.html lines 133-187.
export default function TransformScene() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        opacity: 'var(--o-wire, 0)',
        visibility: cssVar<'visibility'>('var(--v-wire, hidden)'),
        backgroundColor: '#F8FAFC',
        backgroundImage: 'radial-gradient(#E2E8F0 1.2px, transparent 1.2px)',
        backgroundSize: '28px 28px',
        backgroundPosition: 'var(--wire-bg, 0px) 0px',
      }}
    >
      <div className="nx-anchor">
        <div
          style={{
            position: 'absolute',
            left: -2400,
            top: -165,
            width: 4800,
            height: 334,
            backgroundImage: "url('/landing/s2-fibre-tile.webp')",
            backgroundRepeat: 'repeat-x',
            backgroundSize: '1563px 334px',
            backgroundPosition: 'var(--wire-x, 0px) 0px',
          }}
        />
        <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, transform: 'var(--t-wire, none)' }}>
          <svg
            viewBox="-200 -600 3600 1200"
            width={3600}
            height={1200}
            style={{ position: 'absolute', left: -200, top: -600, overflow: 'visible' }}
          >
            <path d="M1420 -180 H1110 M1122 -190 L1110 -180 L1122 -170" stroke="#94A3B8" strokeWidth={1.5} fill="none" strokeDasharray="6 6" />
            <path d="M1094 -188 L1106 -172 M1106 -188 L1094 -172" stroke="#EF4444" strokeWidth={2} strokeLinecap="square" />
            <path d="M1420 180 H1110 M1122 170 L1110 180 L1122 190" stroke="#94A3B8" strokeWidth={1.5} fill="none" strokeDasharray="6 6" />
            <path d="M1094 172 L1106 188 M1106 172 L1094 188" stroke="#EF4444" strokeWidth={2} strokeLinecap="square" />
            <text x={1160} y={-194} fontSize={11} fill="#64748B" fontFamily="JetBrains Mono, monospace" letterSpacing={2}>
              INBOUND · BLOCKED
            </text>
            <text x={1160} y={206} fontSize={11} fill="#64748B" fontFamily="JetBrains Mono, monospace" letterSpacing={2}>
              NO OPEN PORTS
            </text>
            <rect x={1442} y={-8} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} />
            <rect x={1522} y={-8} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} />
            <rect x={1602} y={-8} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} />
            <rect x={1747} y={62} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} opacity={0.8} />
            <rect x={1797} y={142} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} opacity={0.5} />
            <rect x={1847} y={232} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} opacity={0.25} />
            <g style={{ opacity: 'calc(0.35 + var(--g1, 0) * 0.65)' }}>
              <ellipse cx={1700} cy={0} rx={20} ry={62} fill="none" stroke="#7C3AED" strokeWidth={3} />
              <path d="M1700 -62 V-112" stroke="#7C3AED" strokeWidth={1} />
            </g>
            <rect x={2372} y={-8} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} />
            <rect x={2472} y={-8} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} />
            <rect x={2647} y={66} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} opacity={0.7} />
            <rect x={2697} y={156} width={16} height={16} fill="#94A3B8" stroke="#FFFFFF" strokeWidth={2} opacity={0.35} />
            <g style={{ opacity: 'calc(0.35 + var(--g2, 0) * 0.65)' }}>
              <ellipse cx={2600} cy={0} rx={20} ry={62} fill="none" stroke="#0891B2" strokeWidth={3} />
              <path d="M2600 -62 V-112" stroke="#0891B2" strokeWidth={1} />
            </g>
          </svg>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/s2-agent.webp"
            alt=""
            style={{
              position: 'absolute',
              left: 339,
              top: -346,
              width: 722,
              height: 722,
              maxWidth: 'none',
              WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, #000 7%, #000 93%, transparent 100%)',
              maskImage: 'linear-gradient(90deg, transparent 0%, #000 7%, #000 93%, transparent 100%)',
            }}
          />
          <div
            className="glowpulse"
            style={{
              position: 'absolute',
              left: 592,
              top: -47,
              width: 200,
              height: 100,
              background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.45), rgba(99,102,241,0) 70%)',
            }}
          />
          <div className="nd" style={{ left: 545, top: -360, width: 310, opacity: 'calc(0.45 + var(--g0, 0) * 0.55)' }}>
            <div className="nd-h">
              <span className="nd-i">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/logos/sql-server.svg" alt="" width={18} height={18} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="nd-l">SOURCE</span>
                <span className="nd-t">orders-north</span>
              </span>
            </div>
            <div className="nd-r">
              <span>Provider</span>
              <b>SQL Server (via agent)</b>
            </div>
            <div className="nd-r">
              <span>Connection</span>
              <b>outbound only</b>
            </div>
            <div className="nd-f">
              <i style={{ background: '#10B981' }} />
              Reading
            </div>
            <span className="nd-p" style={{ right: -7, top: 74 }} />
          </div>
          <div className="nd" style={{ left: 1550, top: -262, width: 300, opacity: 'calc(0.45 + var(--g1, 0) * 0.55)' }}>
            <div className="nd-h">
              <span className="nd-i" style={{ background: '#111111', borderColor: '#111111' }}>
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                  <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" stroke="#FFFFFF" strokeWidth={1.4} />
                </svg>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="nd-l">TRANSFORM</span>
                <span className="nd-t">Filter rows</span>
              </span>
            </div>
            <div className="nd-r">
              <span>Rule</span>
              <b>branch = &apos;North&apos;</b>
            </div>
            <div className="nd-f">
              <i />
              Ready
            </div>
            <span className="nd-p" style={{ left: -7, top: 74 }} />
            <span className="nd-p" style={{ right: -7, top: 74 }} />
          </div>
          <div className="nd" style={{ left: 2450, top: -262, width: 300, opacity: 'calc(0.45 + var(--g2, 0) * 0.55)' }}>
            <div className="nd-h">
              <span className="nd-i" style={{ background: '#111111', borderColor: '#111111' }}>
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                  <path d="M13 5.5A5.5 5.5 0 0 0 3.5 4.5M3 10.5A5.5 5.5 0 0 0 12.5 11.5" stroke="#FFFFFF" strokeWidth={1.4} />
                  <path d="M3.5 1.5v3h3M12.5 14.5v-3h-3" stroke="#FFFFFF" strokeWidth={1.4} />
                </svg>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="nd-l">TRANSFORM</span>
                <span className="nd-t">Incremental sync</span>
              </span>
            </div>
            <div className="nd-r">
              <span>Mode</span>
              <b>new or changed rows</b>
            </div>
            <div className="nd-f">
              <i />
              Ready
            </div>
            <span className="nd-p" style={{ left: -7, top: 74 }} />
            <span className="nd-p" style={{ right: -7, top: 74 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

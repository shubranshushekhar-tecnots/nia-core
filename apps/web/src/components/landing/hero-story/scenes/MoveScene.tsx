import { cssVar } from '../cssVar';

const DRIFTS: Array<{ left: string; top: string; size: number; delay?: string }> = [
  { left: '10%', top: '60%', size: 4 },
  { left: '22%', top: '36%', size: 3, delay: '-2s' },
  { left: '31%', top: '76%', size: 4, delay: '-4s' },
  { left: '39%', top: '24%', size: 3, delay: '-1s' },
  { left: '61%', top: '42%', size: 3, delay: '-3s' },
  { left: '77%', top: '30%', size: 3, delay: '-2.5s' },
  { left: '86%', top: '58%', size: 4, delay: '-4.5s' },
  { left: '93%', top: '38%', size: 3, delay: '-1.5s' },
];

// 03 · MOVE — undersea, revealed under a moving waterline. Port of
// designs/nia-hero/index.html lines 262-313.
export default function MoveScene() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, zIndex: 3,
          clipPath: 'inset(var(--sea-top, 100%) 0 0 0)',
          visibility: cssVar<'visibility'>('var(--v-sea, hidden)'),
          backgroundColor: '#7FA8E8',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, backgroundImage: "url('/landing/s3-water.webp')", backgroundSize: 'cover', backgroundPosition: 'center top' }} />
        <div style={{ position: 'absolute', inset: 0, backgroundImage: "url('/landing/s3-caustics.webp')", backgroundSize: 'cover', mixBlendMode: 'screen', opacity: 0.35 }} />
        {DRIFTS.map((d, i) => (
          <span
            key={i}
            className="drift"
            style={{
              position: 'absolute', left: d.left, top: d.top, width: d.size, height: d.size,
              borderRadius: '50%', background: '#FFFFFF', animationDelay: d.delay,
            }}
          />
        ))}
        <div className="nx-anchor">
          <div
            style={{
              position: 'absolute', left: -3000, top: 20, width: 6000, height: 1200, backgroundColor: '#CFE3F2',
              backgroundImage: "url('/landing/s3-seafloor-tile.webp')", backgroundRepeat: 'repeat-x',
              backgroundSize: '2508px 459px', backgroundPosition: 'var(--seab-x, 0px) 0px',
              WebkitMaskImage: 'linear-gradient(180deg, transparent 0, #000 100px)',
              maskImage: 'linear-gradient(180deg, transparent 0, #000 100px)',
            }}
          />
          <div style={{ position: 'absolute', left: -900, top: -150, width: 1000, height: 300, background: 'radial-gradient(closest-side at 90% 50%, rgba(99,102,241,0.22), rgba(99,102,241,0.06) 60%, rgba(99,102,241,0))', pointerEvents: 'none' }} />
          <div
            style={{
              position: 'absolute', left: -2600, top: -66, width: 5200, height: 204,
              backgroundImage: "url('/landing/s3-cable-tile.webp')", backgroundRepeat: 'repeat-x',
              backgroundSize: '1459px 204px', backgroundPosition: 'var(--sea-x, 0px) 0px',
              WebkitMaskImage: 'linear-gradient(180deg, #000 0, #000 112px, transparent 196px)',
              maskImage: 'linear-gradient(180deg, #000 0, #000 112px, transparent 196px)',
            }}
          />
        </div>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(79,70,229,0) 0%, rgba(79,70,229,0) 60%, rgba(79,70,229,0.12) 100%)' }} />
        <div className="nx-anchor">
          <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, opacity: 'var(--lens, 0)' }}>
            <svg width={2} height={80} viewBox="0 0 2 80" style={{ position: 'absolute', left: -306, top: -80, overflow: 'visible' }}>
              <path d="M1 0 V74" stroke="#4F46E5" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="3 4" />
            </svg>
            <span style={{ position: 'absolute', left: -310, top: -6, width: 8, height: 8, background: '#4F46E5', boxShadow: '0 0 0 4px rgba(99,102,241,0.18)' }} />
            <div
              style={{
                position: 'absolute', left: -410, top: -290, width: 210, height: 210, borderRadius: '50%',
                background: 'radial-gradient(circle at 50% 40%, #FFFFFF 0%, #EEF2FF 60%, #E0E7FF 100%)',
                border: '1px solid #C7D2FE', boxShadow: '0 0 0 8px rgba(255,255,255,0.45), 0 24px 50px rgba(30,41,90,0.18)',
                overflow: 'hidden',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/s3-cross-section.webp" alt="" style={{ position: 'absolute', left: 19, top: 14, width: 190, height: 190, maxWidth: 'none', filter: 'drop-shadow(0 10px 16px rgba(30,41,90,0.22))' }} />
            </div>
            <div
              style={{
                position: 'absolute', left: 150, top: -290, width: 300, background: 'rgba(255,255,255,0.82)',
                WebkitBackdropFilter: 'blur(12px)', backdropFilter: 'blur(12px)',
                border: '1px solid rgba(203,213,225,0.9)', boxShadow: '0 24px 50px rgba(30,41,90,0.14)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #E2E8F0', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.18em', color: '#64748B' }}>
                <span>CROSS-SECTION</span>
                <span>/ 03</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px', borderBottom: '1px solid #E2E8F0' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.18em', color: '#4F46E5' }}>ENCRYPTED SHEATH</span>
                <span style={{ fontSize: 15, color: '#0F172A' }}>Passwords and keys stored encrypted</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.18em', color: '#4F46E5' }}>ONE STRAND PER WORKSPACE</span>
                <span style={{ fontSize: 15, color: '#0F172A' }}>Each workspace&apos;s data kept separate</span>
              </div>
            </div>
          </div>
          <div
            style={{
              position: 'absolute', left: -130, top: 140, width: 540, display: 'flex', alignItems: 'center',
              gap: 22, padding: '16px 20px', boxSizing: 'border-box', background: 'rgba(255,255,255,0.82)',
              WebkitBackdropFilter: 'blur(12px)', backdropFilter: 'blur(12px)',
              border: '1px solid rgba(203,213,225,0.9)', boxShadow: '0 24px 50px rgba(30,41,90,0.14)',
              opacity: 'var(--gauge, 0)',
            }}
          >
            <svg width={140} height={80} viewBox="-70 -70 140 80" style={{ flexShrink: 0 }}>
              <path d="M-60 0 A60 60 0 0 1 -48.5 -35.3" stroke="#10B981" strokeWidth={8} fill="none" />
              <path d="M-48.5 -35.3 A60 60 0 0 1 60 0" stroke="#E2E8F0" strokeWidth={8} fill="none" />
              <path d="M-44 -32 L-56 -40.5" stroke="#F59E0B" strokeWidth={2.5} />
              <path d="M0 0 L-46.6 -2.9" stroke="#0F172A" strokeWidth={2} />
              <rect x={-4} y={-4} width={8} height={8} fill="#0F172A" />
            </svg>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.18em', color: '#4F46E5' }}>DELETE GUARD · 20% LIMIT</span>
              <span style={{ fontSize: 15, color: '#0F172A', lineHeight: 1.4 }}>Blocks any run that would delete more than 20% by mistake.</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#047857' }}>
                <span style={{ width: 7, height: 7, background: '#10B981' }} />
                THIS RUN · WITHIN LIMIT
              </span>
            </div>
          </div>
        </div>
      </div>
      <svg
        aria-hidden="true"
        viewBox="0 0 1200 40"
        preserveAspectRatio="none"
        style={{
          position: 'absolute', left: 0, top: 'var(--sea-top, 100%)', width: '100%', height: 40,
          transform: 'translateY(-50%)', zIndex: 3, visibility: cssVar<'visibility'>('var(--v-wave, hidden)'), pointerEvents: 'none',
        }}
      >
        <path d="M0 20 Q50 6 100 20 T200 20 T300 20 T400 20 T500 20 T600 20 T700 20 T800 20 T900 20 T1000 20 T1100 20 T1200 20" stroke="#FFFFFF" strokeWidth={5} fill="none" vectorEffect="non-scaling-stroke" />
        <path d="M0 24 Q50 10 100 24 T200 24 T300 24 T400 24 T500 24 T600 24 T700 24 T800 24 T900 24 T1000 24 T1100 24 T1200 24" stroke="#7DD3FC" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </>
  );
}

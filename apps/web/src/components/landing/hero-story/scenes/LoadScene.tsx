import { cssVar } from '../cssVar';

const ROWS = [
  { id: 4712, y: -19.0 },
  { id: 4745, y: -67.0 },
  { id: 4790, y: -115.0 },
  { id: 4806, y: -163.0 },
];

const ORBS: Array<{ left: number; top: number; n: number; logo?: string; alt?: string; label?: string }> = [
  { left: -537, top: -182, n: 0, logo: 'snowflake', alt: 'Snowflake' },
  { left: -484, top: -236, n: 1, logo: 'bigquery', alt: 'BigQuery' },
  { left: -409, top: -282, n: 2, logo: 'redshift', alt: 'Redshift' },
  { left: -315, top: -319, n: 3, logo: 'databricks', alt: 'Databricks' },
  { left: -207, top: -345, n: 4, logo: 'postgresql', alt: 'PostgreSQL' },
  { left: -90, top: -358, n: 5, logo: 'google-sheets', alt: 'Google Sheets' },
  { left: 30, top: -358, n: 6, logo: 'excel', alt: 'Excel' },
  { left: 147, top: -345, n: 7, logo: 'power-bi', alt: 'Power BI' },
  { left: 255, top: -319, n: 8, logo: 'tableau', alt: 'Tableau' },
  { left: 349, top: -282, n: 9, logo: 'looker', alt: 'Looker' },
  { left: 424, top: -236, n: 10, logo: 'salesforce', alt: 'Salesforce' },
  { left: 477, top: -182, n: 11, label: 'PL' },
];

const APPS = [
  { left: -360, top: -155, n: 12 },
  { left: -311, top: -190, n: 13 },
  { left: -243, top: -218, n: 14 },
  { left: -162, top: -238, n: 15 },
  { left: -72, top: -249, n: 16 },
  { left: 22, top: -249, n: 17 },
  { left: 112, top: -238, n: 18 },
  { left: 193, top: -218, n: 19 },
  { left: 261, top: -190, n: 20 },
  { left: 310, top: -155, n: 21 },
];

// 04 · LOAD — destination hall: a 3D row stack landing into a table, orbited
// by destination logos. Port of designs/nia-hero/index.html lines 189-260.
export default function LoadScene() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, zIndex: 2, background: '#F8FAFC',
          opacity: 'var(--o-dest, 0)', visibility: cssVar<'visibility'>('var(--v-dest, hidden)'),
        }}
      >
        <div style={{ position: 'absolute', left: '50%', top: '50%', width: 1672, height: 941, transform: 'translate(-836px, -467px) scale(var(--s-dest, 1))', transformOrigin: '836px 467px' }}>
          <img src="/landing/s4-destination-hall.webp" alt="" style={{ position: 'absolute', left: 0, top: 0, width: 1672, height: 941, maxWidth: 'none', display: 'block' }} />
          <div style={{ position: 'absolute', left: 650, top: 618, width: 372, height: 40, background: 'radial-gradient(ellipse at center, rgba(15,23,42,0.22), rgba(15,23,42,0) 70%)' }} />
          <div style={{ position: 'absolute', left: 486, top: 207, width: 700, height: 520, opacity: 'var(--dbglow, 0)' }}>
            <div className="glowpulse" style={{ width: '100%', height: '100%', background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.42), rgba(99,102,241,0) 62%)' }} />
          </div>
          <div style={{ position: 'absolute', left: 836, top: 600, width: 0, height: 0 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, perspective: 2200, perspectiveOrigin: '0 -260px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, transformStyle: 'preserve-3d', transform: 'rotateX(-11deg) rotateY(0deg)' }}>
                {ROWS.map((row) => (
                  <div key={row.id} style={{ position: 'absolute', left: 0, top: 0, transformStyle: 'preserve-3d', transform: `translateY(${row.y}px)` }}>
                    <div
                      style={{
                        position: 'absolute', left: -220.0, top: -19.0, width: 440, height: 38, boxSizing: 'border-box',
                        background: 'linear-gradient(180deg, rgba(255,255,255,0.78), rgba(241,245,249,0.7))',
                        border: '1px solid rgba(148,163,184,0.55)', boxShadow: 'inset 3px 0 0 #CBD5E1', color: '#64748B',
                        transform: 'translateZ(95.0px)', display: 'grid', gridTemplateColumns: '96px 120px 1fr',
                        alignItems: 'center', padding: '0 18px', fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
                      }}
                    >
                      <span>{row.id}</span>
                      <span>North</span>
                      <span>synced</span>
                    </div>
                    <div style={{ position: 'absolute', left: -220.0, top: -95.0, width: 440, height: 190, boxSizing: 'border-box', background: 'linear-gradient(135deg, rgba(255,255,255,0.92), rgba(226,232,240,0.85))', border: '1px solid rgba(148,163,184,0.55)', transform: 'rotateX(90deg) translateZ(19.0px)' }} />
                    <div style={{ position: 'absolute', left: -95.0, top: -19.0, width: 190, height: 38, boxSizing: 'border-box', background: 'linear-gradient(180deg, rgba(226,232,240,0.95), rgba(203,213,225,0.9))', border: '1px solid rgba(148,163,184,0.55)', transform: 'rotateY(90deg) translateZ(220.0px)' }} />
                  </div>
                ))}
                <div
                  style={{
                    position: 'absolute', left: 0, top: 0, transformStyle: 'preserve-3d',
                    transform: 'translateY(-211.0px) translateY(calc((1 - var(--rowin, 0)) * -260px))',
                    opacity: 'clamp(0, calc(var(--rowin, 0) * 3), 1)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute', left: -220.0, top: -19.0, width: 440, height: 38, boxSizing: 'border-box',
                      background: 'linear-gradient(180deg, #6366F1, #4F46E5)', border: '1px solid #A5B4FC',
                      boxShadow: '0 0 40px 6px rgba(99,102,241,0.45), inset 3px 0 0 #E0E7FF', color: '#FFFFFF',
                      transform: 'translateZ(95.0px)', display: 'grid', gridTemplateColumns: '96px 120px 1fr',
                      alignItems: 'center', padding: '0 18px', fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
                    }}
                  >
                    <span>4821</span>
                    <span>North</span>
                    <span>■ just landed</span>
                  </div>
                  <div style={{ position: 'absolute', left: -220.0, top: -95.0, width: 440, height: 190, boxSizing: 'border-box', background: 'linear-gradient(135deg, rgba(165,180,252,0.95), rgba(99,102,241,0.9))', border: '1px solid rgba(224,231,255,0.9)', transform: 'rotateX(90deg) translateZ(19.0px)' }} />
                  <div style={{ position: 'absolute', left: -95.0, top: -19.0, width: 190, height: 38, boxSizing: 'border-box', background: 'linear-gradient(180deg, #4F46E5, #3730A3)', border: '1px solid #818CF8', transform: 'rotateY(90deg) translateZ(220.0px)' }} />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="nx-anchor">
          <svg width={1200} height={700} viewBox="-600 -400 1200 700" style={{ position: 'absolute', left: -600, top: -400, overflow: 'visible', opacity: 'var(--orbit, 0)' }} aria-hidden="true">
            <path d="M-528 -116 A540 270 0 0 1 528 -116" stroke="#CBD5E1" strokeWidth={1} fill="none" strokeDasharray="4 6" />
            <path d="M-352 -111 A370 165 0 0 1 352 -111" stroke="#C7D2FE" strokeWidth={1} fill="none" strokeDasharray="2 6" />
          </svg>
          {ORBS.map((orb) => (
            <div
              key={orb.n}
              className="orb"
              style={{
                left: orb.left, top: orb.top,
                opacity: `clamp(0, calc(var(--orbit, 0) * 24 - ${orb.n}), 1)`,
                ...(orb.label ? { fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 500, color: '#0F172A' } : {}),
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {orb.logo ? <img src={`/landing/logos/${orb.logo}.svg`} alt={orb.alt} /> : orb.label}
            </div>
          ))}
          {APPS.map((app, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={app.n}
              src={`/landing/apps/app-${String(i + 1).padStart(2, '0')}.webp`}
              alt=""
              style={{
                position: 'absolute', left: app.left, top: app.top, width: 50, height: 50, maxWidth: 'none', objectFit: 'contain',
                filter: 'drop-shadow(0 6px 12px rgba(15,23,42,0.14))',
                opacity: `clamp(0, calc(var(--orbit, 0) * 24 - ${app.n}), 1)`,
              }}
            />
          ))}
          <div
            style={{
              position: 'absolute', left: -170, top: -170, width: 340, height: 42, boxSizing: 'border-box',
              background: '#FFFFFF', border: '1px solid #CBD5E1', boxShadow: '0 10px 30px rgba(15,23,42,0.08)',
              opacity: 'var(--rowin, 0)', fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              letterSpacing: '0.14em', color: '#0F172A',
            }}
          >
            <div style={{ position: 'relative', height: '100%', marginLeft: -4 }}>
              <span className="cyc" style={{ animationDelay: '0s' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/logos/snowflake.svg" alt="" width={16} height={16} />
                SNOWFLAKE · BRANCH_SALES
              </span>
              <span className="cyc" style={{ animationDelay: '-7.5s' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/logos/bigquery.svg" alt="" width={16} height={16} />
                BIGQUERY · BRANCH_SALES
              </span>
              <span className="cyc" style={{ animationDelay: '-5s' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/logos/google-sheets.svg" alt="" width={16} height={16} />
                GOOGLE SHEETS · BRANCH_SALES
              </span>
              <span className="cyc" style={{ animationDelay: '-2.5s' }}>
                <span style={{ width: 16, height: 16, border: '1px solid #0F172A', fontSize: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', letterSpacing: 0 }}>PL</span>
                PLANOMETRY · BRANCH_SALES
              </span>
            </div>
            <span style={{ position: 'absolute', right: 12, top: 14, color: '#4F46E5' }}>+1</span>
          </div>
        </div>
      </div>
    </>
  );
}

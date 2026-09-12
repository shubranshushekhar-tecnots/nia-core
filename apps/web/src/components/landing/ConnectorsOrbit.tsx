import type { CSSProperties } from 'react';
import Reveal from './Reveal';
import { darkBtn, ghostBtnLg, kickerStyle } from './styles';

const APP = 'Nia Core Shell.dc.html';

type Ring = { r: number; dur: string; rev: boolean; tiles: [string, string][] };

const RINGS: Ring[] = [
  { r: 360, dur: '46s', rev: false, tiles: [['My', 'var(--c-data)'], ['BI', 'var(--c-condition)'], ['Sb', 'var(--c-data)']] },
  { r: 490, dur: '72s', rev: true, tiles: [['P', 'var(--c-data)'], ['Sf', 'var(--c-action)'], ['Mg', 'var(--c-data)'], ['S', 'var(--c-ai)']] },
  { r: 620, dur: '98s', rev: false, tiles: [['aws', 'var(--c-action)'], ['✦', 'var(--c-ai)'], ['Bq', 'var(--c-action)'], ['▤', 'var(--c-condition)'], ['Az', 'var(--c-action)']] },
];

const orbitTiles: { mono: string; style: CSSProperties }[] = [];
RINGS.forEach((ring) => {
  const step = 360 / ring.tiles.length;
  ring.tiles.forEach(([mono, color], i) => {
    orbitTiles.push({
      mono,
      style: {
        ['--a' as string]: `${i * step}deg`,
        ['--r' as string]: `${-ring.r}px`,
        ['--dur' as string]: ring.dur,
        color,
        ...(ring.rev ? { animationDirection: 'reverse' } : {}),
      } as CSSProperties,
    });
  });
});

export default function ConnectorsOrbit() {
  return (
    <section id="connectors" style={{ position: 'relative', overflow: 'hidden', marginTop: 34, padding: '170px 24px 180px' }}>
      <div className="orings" aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'none' }}>
        <span style={{ position: 'absolute', left: '50%', top: '50%', width: 720, height: 720, margin: '-360px 0 0 -360px', borderRadius: '50%', border: '1px solid rgba(203,213,225,.75)' }} />
        <span style={{ position: 'absolute', left: '50%', top: '50%', width: 980, height: 980, margin: '-490px 0 0 -490px', borderRadius: '50%', border: '1px solid rgba(203,213,225,.5)' }} />
        <span style={{ position: 'absolute', left: '50%', top: '50%', width: 1240, height: 1240, margin: '-620px 0 0 -620px', borderRadius: '50%', border: '1px solid rgba(203,213,225,.3)' }} />
        {orbitTiles.map((t, i) => (
          <span key={i} className="otile" style={t.style}>{t.mono}</span>
        ))}
      </div>
      <Reveal style={{ position: 'relative', zIndex: 2, maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
        <span style={kickerStyle}>60+ CONNECTORS · READ &amp; WRITE</span>
        <h2 style={{ margin: 0, fontSize: 'clamp(28px,3.4vw,42px)', fontWeight: 700, lineHeight: 1.1, letterSpacing: '-.03em' }}>
          Every source you run on,<br /><span style={{ color: 'var(--muted)' }}>orbiting one canvas</span>
        </h2>
        <p style={{ margin: 0, maxWidth: 440, fontSize: 15, lineHeight: 1.6, color: 'var(--secondary)' }}>
          Databases, warehouses, files and BI tools — connect once with a read-only role and reuse it in every pipeline.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={APP} style={darkBtn}>Browse connectors</a>
          <a href="#pricing" style={ghostBtnLg}>Start free</a>
        </div>
      </Reveal>
    </section>
  );
}

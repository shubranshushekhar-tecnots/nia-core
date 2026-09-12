import Reveal from './Reveal';
import CountUp from './CountUp';
import { statCardStyle } from './styles';

const STATS = [
  { value: '2.4M', target: 2.4, suffix: 'M', label: 'Runs a month across the platform' },
  { value: '38.2M', target: 38.2, suffix: 'M', label: 'Rows moved every night' },
  { value: '96.4', target: 96.4, suffix: '%', label: 'Runs that finish first time' },
  { value: '60', target: 60, suffix: '+', label: 'Connectors ready to use' },
];

export default function Stats() {
  return (
    <section id="stats" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0' }}>
      <Reveal style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', color: 'var(--muted)' }}>RUNNING AT SCALE</span>
        <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
          {STATS.map((s) => (
            <div key={s.label} style={statCardStyle}>
              <CountUp target={s.target} suffix={s.suffix} value={s.value} style={{ fontSize: 31, fontWeight: 700, letterSpacing: '-.03em' }} />
              <span style={{ fontSize: 12.5, color: 'var(--secondary)' }}>{s.label}</span>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Placeholder figures pending marketing review — not live product metrics.</span>
      </Reveal>
    </section>
  );
}

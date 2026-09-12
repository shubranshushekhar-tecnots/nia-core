import Reveal from './Reveal';

const ORGS = ['Meridian Analytics', 'Retail Group', 'Harbour Foods', 'Kestrel Freight', 'Nord Labs', 'Icecream Co'];

export default function TrustedBy() {
  return (
    <Reveal
      as="section"
      style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '56px 24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', color: 'var(--muted)' }}>MOVING ROWS EVERY NIGHT FOR</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '14px 34px' }}>
        {ORGS.map((name) => (
          <span key={name} style={{ fontSize: 15, fontWeight: 700, color: 'var(--line-strong)' }}>{name}</span>
        ))}
      </div>
    </Reveal>
  );
}

import Reveal from './Reveal';

const TYPE_CHIPS = [
  { label: 'Trigger', c: 'var(--c-trigger)' },
  { label: 'Data', c: 'var(--c-data)' },
  { label: 'Action', c: 'var(--c-action)' },
  { label: 'Condition', c: 'var(--c-condition)' },
  { label: 'AI', c: 'var(--c-ai)' },
];

export default function TypeChips() {
  return (
    <Reveal as="section" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '0 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', color: 'var(--muted)' }}>ONE COLOR LANGUAGE · FIVE NODE TYPES</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 9 }}>
        {TYPE_CHIPS.map((c) => (
          <span
            key={c.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 14px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600, color: 'var(--secondary)' }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.c }} />
            {c.label}
          </span>
        ))}
      </div>
    </Reveal>
  );
}

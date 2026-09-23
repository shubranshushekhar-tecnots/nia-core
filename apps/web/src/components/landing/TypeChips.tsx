import type { ReactElement } from 'react';
import Container from './hairline/Container';
import SectionRule from './hairline/SectionRule';

// "Node types" band — ported from designs/Connectors — full page-html/
// Connectors.dc.html's NODE TYPES block. This file used to render the same
// five node types as indigo pill chips; rebuilt in place (same filename,
// same content) in the hairline visual language instead of adding a
// parallel component. Glyph geometry (rect coordinates) copied verbatim
// from the design file's inline SVGs.
const NODE_TYPES: { label: string; glyph: ReactElement }[] = [
  {
    label: 'Trigger',
    glyph: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#101014" aria-hidden="true">
        <rect x="2" y="9" width="6" height="6" />
        <rect x="10" y="11" width="12" height="2" />
      </svg>
    ),
  },
  {
    label: 'Data',
    glyph: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#101014" aria-hidden="true">
        <rect x="4" y="4" width="16" height="4" />
        <rect x="4" y="11" width="16" height="3" />
        <rect x="4" y="17" width="16" height="2" />
      </svg>
    ),
  },
  {
    label: 'Action',
    glyph: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#101014" aria-hidden="true">
        <rect x="10" y="3" width="4" height="18" />
        <rect x="3" y="10" width="18" height="4" />
      </svg>
    ),
  },
  {
    label: 'Condition',
    glyph: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#101014" aria-hidden="true">
        <rect x="2" y="10" width="8" height="4" />
        <rect x="10" y="5" width="2" height="14" />
        <rect x="14" y="3" width="8" height="4" />
        <rect x="14" y="17" width="8" height="4" />
      </svg>
    ),
  },
  {
    label: 'AI',
    glyph: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#101014" aria-hidden="true">
        <rect x="3" y="3" width="5" height="5" />
        <rect x="10" y="3" width="5" height="5" />
        <rect x="17" y="3" width="4" height="5" />
        <rect x="3" y="10" width="5" height="5" />
        <rect x="10" y="10" width="5" height="5" fill="#594cdf" />
        <rect x="17" y="10" width="4" height="5" />
        <rect x="3" y="17" width="5" height="4" />
        <rect x="10" y="17" width="5" height="4" />
        <rect x="17" y="17" width="4" height="4" />
      </svg>
    ),
  },
];

export default function TypeChips() {
  return (
    <section className="hl-scope">
      <Container>
        <SectionRule tone="strong" />
        <div className="hl-nodetypes-wrap" style={{ padding: '48px 0' }}>
          <div style={{ width: 200, flexShrink: 0, fontSize: 11, fontWeight: 500, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--hl-ink-3)', lineHeight: '18px' }}>
            One colour language<br />Five node types
          </div>
          <div className="hl-nodetypes-grid">
            {NODE_TYPES.map((n) => (
              <div key={n.label} className="hl-nodetype">
                {n.glyph}
                <span style={{ fontSize: 17, color: 'var(--hl-ink)' }}>{n.label}</span>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

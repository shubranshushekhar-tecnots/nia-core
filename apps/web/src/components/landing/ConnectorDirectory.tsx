'use client';

import { useMemo, useState } from 'react';
import Container from './hairline/Container';
import SectionRule from './hairline/SectionRule';
import Eyebrow from './hairline/Eyebrow';
import { sectionH2, bodyStyle } from './hairline/styles';
import { CONNECTORS, CONNECTOR_FILTERS, type ConnectorGroup } from './connectorsData';

// Directory section — ported from designs/Connectors — full page-html/
// Connectors.dc.html's DIRECTORY block. Filter pills are real <button>s
// with aria-pressed; the count region is aria-live="polite" so screen
// readers hear the updated total when a filter is picked.
export default function ConnectorDirectory() {
  const [active, setActive] = useState<'All' | ConnectorGroup>('All');

  const rows = useMemo(
    () => (active === 'All' ? CONNECTORS : CONNECTORS.filter((c) => c.group === active)),
    [active],
  );

  return (
    <section className="hl-scope">
      <Container style={{ paddingBottom: 112 }}>
        <SectionRule tone="strong" />

        <div style={{ paddingTop: 80, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <Eyebrow>The directory</Eyebrow>
            <h2 style={{ ...sectionH2, marginTop: 24 }}>Sixty-plus, and counting</h2>
          </div>
          <div aria-live="polite" style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--hl-ink-3)' }}>
            Showing {rows.length} of {CONNECTORS.length}
          </div>
        </div>

        <div style={{ marginTop: 40, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {CONNECTOR_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="hl-pill"
              aria-pressed={active === f}
              onClick={() => setActive(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="hl-directory-grid" style={{ marginTop: 48 }}>
          {rows.map((c) => (
            <div key={c.name} style={{ borderTop: '1px solid var(--hl-rule-hairline)', padding: '20px 0 26px 0' }}>
              <div style={{ fontSize: 18, lineHeight: '26px', letterSpacing: '-.008em', color: 'var(--hl-ink)' }}>{c.name}</div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  color: c.mode === 'Read · Write' ? 'var(--hl-accent)' : 'var(--hl-ink-4)',
                }}
              >
                {c.mode}
              </div>
            </div>
          ))}
        </div>

        <p style={{ ...bodyStyle, marginTop: 40, fontSize: 14, lineHeight: '22px', color: 'var(--hl-ink-3)' }}>
          Read and write means Nia can land rows back into the source. Read-only connectors are extract-only by design — ask us and we will tell you why.
        </p>
      </Container>
    </section>
  );
}

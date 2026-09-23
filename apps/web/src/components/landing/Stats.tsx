import Container from './hairline/Container';
import SectionRule from './hairline/SectionRule';
import Eyebrow from './hairline/Eyebrow';
import Reveal from './Reveal';
import CountUp from './CountUp';
import { pageH1, leadStyle, statFigure } from './hairline/styles';

// Pricing page HEADER + STATS — ported from designs/Pricing — full
// page-html/Pricing.dc.html. This file renders first in the merged
// single-page layout (LandingPage.tsx order: ... Stats -> Pricing ...),
// so it absorbs the design's HEADER block (eyebrow/h1/lead) ahead of the
// STATS band it already owned, keeping the design's Header -> Stats ->
// Plans reading order without reordering existing sections.
const STATS = [
  { value: '2.4M', target: 2.4, suffix: 'M', label: 'Runs a month across the platform', accent: false },
  { value: '38.2M', target: 38.2, suffix: 'M', label: 'Rows moved every night', accent: false },
  { value: '96.4', target: 96.4, suffix: '%', label: 'Runs that finish first time', accent: false },
  { value: '60', target: 60, suffix: '+', label: 'Connectors ready to use', accent: true },
];

export default function Stats() {
  return (
    <section id="stats" className="hl-scope">
      <Container style={{ paddingTop: 104, paddingBottom: 96 }}>
        <Eyebrow>Pricing</Eyebrow>
        <h2 style={{ ...pageH1, marginTop: 24, maxWidth: 980 }}>Start free. Upgrade when the rows do.</h2>
        <p className="hl-lead" style={{ ...leadStyle, marginTop: 24, maxWidth: 520 }}>
          Rows per run are the only meter. No per-seat surprise, no charge for a run that failed, no invoice you
          have to reverse-engineer.
        </p>
      </Container>

      <Container>
        <SectionRule tone="strong" />
        <Reveal
          as="div"
          className="hl-stats-grid"
          style={{
            paddingTop: 48,
            paddingBottom: 40,
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          {STATS.map((s, i) => (
            <div
              key={s.label}
              className="hl-fig"
              style={{
                flexGrow: 1,
                minWidth: 200,
                ...(i > 0 ? { paddingLeft: 40, borderLeft: '1px solid var(--hl-rule-hairline)' } : null),
              }}
            >
              <CountUp
                target={s.target}
                suffix={s.suffix}
                value={s.value}
                style={{ ...statFigure, color: s.accent ? 'var(--hl-accent)' : 'var(--hl-ink)' }}
              />
              <div style={{ marginTop: 8, fontSize: 14, lineHeight: '22px', color: 'var(--hl-ink-3)' }}>{s.label}</div>
            </div>
          ))}
        </Reveal>
        <p style={{ margin: 0, paddingBottom: 40, fontSize: 13, lineHeight: '20px', color: 'var(--hl-ink-4)' }}>
          Placeholder figures pending marketing review — not live product metrics.
        </p>
      </Container>
    </section>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import Reveal from './Reveal';

// Ported from designs/What Nia Does — section-html/Main.dc.html (a .dc.html
// design-canvas export), but re-mapped onto the same theme.css tokens the
// rest of the landing page (Hero, Stats, Pricing) already uses,
// instead of the design file's own one-off hex palette.
const INK = 'var(--text)';
const ACCENT = 'var(--primary)';
const LABEL_INACTIVE = 'var(--muted)';
const NUM_INACTIVE = 'var(--secondary)';
const LINE_INACTIVE = 'var(--line)';
const PANEL_BG = 'var(--surface)';
const COUNTER_COLOR = 'var(--muted)';
const BODY_COLOR = 'var(--secondary)';
const EYEBROW_COLOR = 'var(--muted)';

type Item = { n: string; label: string; body: string };

const ITEMS: Item[] = [
  {
    n: '01',
    label: 'Draw the pipeline',
    body: 'Skip the YAML. Sources, transforms and destinations drag onto a grid, connect by hand, and run the moment you press the button. MySQL, Postgres and MongoDB, in any direction.',
  },
  {
    n: '02',
    label: 'Connect once, with least privilege',
    body: 'Authenticate a database once and it becomes a handle you reuse in every pipeline. Nia reads through a role you scope yourself, and writing needs a separate grant you approve and run. It never holds admin access to your data.',
  },
  {
    n: '03',
    label: 'Move millions of rows without babysitting',
    body: "Extracts are checkpointed, so a run that dies at row 900,000 resumes where it stopped instead of starting over. Rerun the same pipeline and rows are matched on your key and updated in place, never duplicated.",
  },
  {
    n: '04',
    label: 'AI proposes the cleaning. It never runs your data.',
    body: 'Nia profiles the source, finds the currency symbols, the mixed date formats and the "N/A"s, and proposes the exact transforms to fix them, with before-and-after values on your own rows. You approve, and it compiles to a fixed plan that runs without a model ever touching a row. ID-like columns are left alone: a zip code stays 02134, not 2134.',
  },
  {
    n: '05',
    label: 'Nothing lands half-done',
    body: "Every run writes to a staging table first and applies in a single transaction, so a failure leaves your destination exactly as it was. Rows that can't be converted are quarantined with the reason, never silently blanked. New destination tables are created with the right types, existing ones are never altered, and a plan refuses to run when the data's shape has drifted.",
  },
];

// SSR-safe breakpoint check, mirrors the matchMedia pattern already used in
// hero-canvas/useHeroApproachProgress.ts (default to desktop until the
// client-side effect can read the real viewport).
function useIsMobile(breakpoint: number): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);

  return isMobile;
}

function Mark1() {
  return (
    <svg
      className="wnd-mk wnd-m1"
      viewBox="0 0 180 180"
      fill={INK}
      role="img"
      aria-label="Three nodes joined by drawn connections, with data running along the path"
    >
      <rect x="8" y="16" width="40" height="40" />
      <rect x="48" y="32" width="42" height="8" />
      <rect x="86" y="36" width="8" height="34" />
      <rect x="70" y="70" width="40" height="40" />
      <rect x="110" y="86" width="42" height="8" />
      <rect x="148" y="90" width="8" height="34" />
      <rect x="132" y="124" width="40" height="40" />
      <rect x="24" y="32" width="8" height="8" fill={ACCENT} />
    </svg>
  );
}

function Mark2() {
  return (
    <svg className="wnd-mk wnd-m2" viewBox="0 0 180 180" fill={INK} role="img" aria-label="Four sources feeding one hub">
      <rect x="68" y="68" width="44" height="44" />
      <rect x="86" y="36" width="8" height="32" />
      <rect x="76" y="8" width="28" height="28" />
      <rect x="36" y="86" width="32" height="8" />
      <rect x="8" y="76" width="28" height="28" />
      <rect x="112" y="86" width="32" height="8" />
      <rect x="144" y="76" width="28" height="28" />
      <rect x="86" y="112" width="8" height="32" />
      <rect x="76" y="144" width="28" height="28" />
      <rect x="86" y="18" width="8" height="8" fill={ACCENT} />
      <rect x="18" y="86" width="8" height="8" fill={ACCENT} />
      <rect x="154" y="86" width="8" height="8" fill={ACCENT} />
      <rect x="86" y="154" width="8" height="8" fill={ACCENT} />
    </svg>
  );
}

function Mark3() {
  const ticks = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <svg
      className="wnd-mk wnd-m3"
      viewBox="0 0 180 180"
      fill={INK}
      role="img"
      aria-label="A schedule dial with a hand sweeping around it"
    >
      {ticks.map((deg) => (
        <g key={deg} transform={`rotate(${deg} 90 90)`}>
          <rect x="86" y="8" width="8" height="18" />
        </g>
      ))}
      <rect x="78" y="78" width="24" height="24" />
      <rect x="86" y="8" width="8" height="40" fill={ACCENT} />
    </svg>
  );
}

function Mark4() {
  return (
    <svg
      className="wnd-mk wnd-m4"
      viewBox="0 0 180 180"
      fill={INK}
      role="img"
      aria-label="One block resolving into a grid of extracted fields"
    >
      <rect x="8" y="58" width="64" height="64" />
      <rect x="72" y="86" width="34" height="8" />
      <rect x="106" y="58" width="16" height="16" />
      <rect x="130" y="58" width="16" height="16" />
      <rect x="154" y="58" width="16" height="16" />
      <rect x="106" y="82" width="16" height="16" />
      <rect x="130" y="82" width="16" height="16" fill={ACCENT} />
      <rect x="154" y="82" width="16" height="16" />
      <rect x="106" y="106" width="16" height="16" />
      <rect x="130" y="106" width="16" height="16" />
      <rect x="154" y="106" width="16" height="16" />
    </svg>
  );
}

function Mark5() {
  return (
    <svg className="wnd-mk wnd-m5" viewBox="0 0 180 180" fill={INK} role="img" aria-label="A check mark built from blocks">
      <rect x="22" y="100" width="28" height="28" />
      <rect x="50" y="128" width="28" height="28" />
      <rect x="78" y="100" width="28" height="28" />
      <rect x="106" y="72" width="28" height="28" />
      <rect x="134" y="44" width="28" height="28" fill={ACCENT} />
    </svg>
  );
}

const MARKS = [Mark1, Mark2, Mark3, Mark4, Mark5];

const rowLabelStyle: CSSProperties = {
  flexGrow: 1,
  fontSize: 'clamp(18px,2.2vw,26px)',
  lineHeight: 1.3,
  letterSpacing: '-.012em',
  fontWeight: 400,
};

function Row({
  item,
  index,
  active,
  tabsMode,
  onSelect,
  onKeyDown,
}: {
  item: Item;
  index: number;
  active: number;
  tabsMode: boolean;
  onSelect: (i: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
}) {
  const isActive = index === active;
  return (
    <button
      type="button"
      id={tabsMode ? `wnd-tab-${index}` : undefined}
      role={tabsMode ? 'tab' : undefined}
      aria-selected={tabsMode ? isActive : undefined}
      aria-controls={tabsMode ? `wnd-panel-${index}` : `wnd-accordion-${index}`}
      aria-expanded={!tabsMode ? isActive : undefined}
      tabIndex={tabsMode ? (isActive ? 0 : -1) : undefined}
      onClick={() => onSelect(index)}
      onKeyDown={(e) => onKeyDown(e, index)}
      className="wnd-row"
      style={{
        appearance: 'none',
        width: '100%',
        boxSizing: 'border-box',
        margin: 0,
        padding: '18px 0',
        background: 'transparent',
        border: 0,
        borderBottom: `1px solid ${isActive ? INK : LINE_INACTIVE}`,
        cursor: 'pointer',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <span className="wnd-num" style={{ flexShrink: 0, width: 24, fontSize: 11, lineHeight: '16px', fontWeight: 500, letterSpacing: '.16em', color: isActive ? ACCENT : NUM_INACTIVE }}>
        {item.n}
      </span>
      <span className="wnd-label" style={{ ...rowLabelStyle, color: isActive ? INK : LABEL_INACTIVE }}>
        {item.label}
      </span>
      {isActive && (
        <svg className="wnd-arrow" width="48" height="16" viewBox="0 0 48 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M0 8 H45 M38 1 L45 8 L38 15" stroke={INK} strokeWidth="1.6" fill="none" />
        </svg>
      )}
    </button>
  );
}

function PanelBody({ item, index, id, tabsMode }: { item: Item; index: number; id: string; tabsMode: boolean }) {
  const Mark = MARKS[index] ?? Mark1;
  return (
    <div
      id={id}
      role={tabsMode ? 'tabpanel' : 'region'}
      aria-labelledby={tabsMode ? `wnd-tab-${index}` : undefined}
      tabIndex={tabsMode ? 0 : undefined}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ fontSize: 11, lineHeight: '16px', fontWeight: 500, letterSpacing: '.16em', color: COUNTER_COLOR }}>
        {item.n} / 05
      </div>
      <div key={index} style={{ marginTop: 24 }}>
        <p className="wnd-pfade wnd-panel-copy" style={{ margin: 0, color: BODY_COLOR, maxWidth: 460 }}>
          {item.body}
        </p>
      </div>
      <div key={`mark-${index}`} style={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 140 }}>
        <Mark />
      </div>
    </div>
  );
}

export default function WhatNiaDoes() {
  const [active, setActive] = useState(0);
  const isMobile = useIsMobile(1024);

  const focusTab = (i: number) => {
    const el = document.getElementById(`wnd-tab-${i}`);
    el?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!isMobile) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (i + 1) % ITEMS.length;
        setActive(next);
        focusTab(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (i - 1 + ITEMS.length) % ITEMS.length;
        setActive(prev);
        focusTab(prev);
      }
    }
  };

  return (
    <section id="product" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '56px 24px 0' }}>
      <Reveal
        as="div"
        style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: EYEBROW_COLOR }}
      >
        Five things, one canvas
      </Reveal>
      <Reveal
        as="h2"
        style={{ margin: '18px 0 0', fontSize: 'clamp(24px,3vw,40px)', lineHeight: 1.15, letterSpacing: '-.03em', fontWeight: 400, color: INK }}
      >
        What Nia <span style={{ color: ACCENT }}>Core</span> does
      </Reveal>
      <div style={{ marginTop: 28, height: 1, background: INK }} />

      <div
        className="wnd-cols"
        style={{
          marginTop: 40,
          marginBottom: 56,
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          gap: 56,
          alignItems: 'flex-start',
        }}
      >
        <div role={isMobile ? undefined : 'tablist'} aria-label={isMobile ? undefined : 'What Nia Core does'} aria-orientation={isMobile ? undefined : 'vertical'} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {ITEMS.map((item, i) => (
            <div key={item.n}>
              <Row item={item} index={i} active={active} tabsMode={!isMobile} onSelect={setActive} onKeyDown={handleKeyDown} />
              {isMobile && i === active && (
                <div className="wnd-panel" style={{ boxSizing: 'border-box', padding: '24px 20px', background: PANEL_BG, border: '1px solid var(--line)', borderRadius: 12, margin: '12px 0 20px' }}>
                  <PanelBody item={item} index={i} id={`wnd-accordion-${i}`} tabsMode={false} />
                </div>
              )}
            </div>
          ))}
        </div>

        {!isMobile && (
          <div className="wnd-panel" style={{ flex: '1 1 0', minWidth: 0, height: 460, boxSizing: 'border-box', padding: 32, background: PANEL_BG, border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            <PanelBody item={ITEMS[active]!} index={active} id={`wnd-panel-${active}`} tabsMode />
          </div>
        )}
      </div>
    </section>
  );
}

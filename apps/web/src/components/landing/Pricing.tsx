'use client';

import { useState } from 'react';
import Container from './hairline/Container';
import SectionRule from './hairline/SectionRule';
import Eyebrow from './hairline/Eyebrow';
import Button from './hairline/Button';
import { priceStyle, cardTitle, bodyStyle } from './hairline/styles';

const APP = 'Nia Core Shell.dc.html';

// Pricing page PLANS — ported from designs/Pricing — full page-html/
// Pricing.dc.html. Header/Stats content lives in Stats.tsx (renders
// first in LandingPage.tsx's section order) — see that file's comment.
type Plan = {
  id: string;
  num: string;
  name: string;
  monthly: string;
  annual: string;
  description: string;
  cta: string;
  recommended: boolean;
  variant: 'outline' | 'solid';
  features: string[];
};

const PLANS: Plan[] = [
  {
    id: 'free',
    num: '01',
    name: 'Free',
    monthly: '$0',
    annual: '$0',
    description: 'For the first pipeline you draw on a Sunday afternoon.',
    cta: 'Start free',
    recommended: false,
    variant: 'outline',
    features: ['1 project', '2 workflows', '100k rows per run', 'Community support'],
  },
  {
    id: 'pro',
    num: '02',
    name: 'Pro',
    monthly: '$19',
    annual: '$15',
    description: 'For the analyst who now has a schedule to keep.',
    cta: 'Start with Pro',
    recommended: false,
    variant: 'outline',
    features: ['10 projects', '25 workflows', '1M rows per run', 'Email support'],
  },
  {
    id: 'org',
    num: '03',
    name: 'Organization',
    monthly: '$99',
    annual: '$79',
    description: 'For the team where somebody else has to be able to read it.',
    cta: 'Start with your team',
    recommended: true,
    variant: 'solid',
    features: ['Seats and roles', 'Unlimited projects and workflows', '50M rows per run', 'SSO and activity log'],
  },
];

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  const cycleLabel = annual ? 'Billed annually' : 'Billed monthly';
  const billedWord = annual ? 'annually' : 'monthly';
  const per = annual ? '/ month, billed yearly' : '/ month';
  const saveColor = annual ? 'var(--hl-accent)' : 'var(--hl-ink-4)';

  return (
    <section id="pricing" className="hl-scope">
      <Container style={{ paddingBottom: 104 }}>
        <SectionRule tone="strong" />

        <div style={{ paddingTop: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <Eyebrow>Three plans &middot; {cycleLabel}</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: saveColor }}>Two months free on annual</span>
            <div role="radiogroup" aria-label="Billing cycle" style={{ display: 'flex', borderRadius: 0, border: '1px solid var(--hl-rule-hairline)', overflow: 'hidden' }}>
              <button
                type="button"
                role="radio"
                aria-checked={!annual}
                className="hl-seg"
                onClick={() => setAnnual(false)}
              >
                Monthly
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={annual}
                className="hl-seg"
                onClick={() => setAnnual(true)}
              >
                Annual
              </button>
            </div>
          </div>
        </div>

        <div className="hl-plans-grid" style={{ marginTop: 56 }}>
          {PLANS.map((p) => (
            <div key={p.id} className="hl-plan-col">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--hl-ink-4)' }}>{p.num}</span>
                {p.recommended && (
                  <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--hl-accent)' }}>
                    Recommended
                  </span>
                )}
              </div>
              <h3 style={{ ...cardTitle, marginTop: 24 }}>{p.name}</h3>
              <div style={{ marginTop: 16, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={priceStyle}>{annual ? p.annual : p.monthly}</span>
                <span style={{ fontSize: 15, color: 'var(--hl-ink-3)' }}>{per}</span>
              </div>
              <p style={{ ...bodyStyle, marginTop: 16, minHeight: 48 }}>{p.description}</p>
              <div style={{ marginTop: 8 }}>
                {p.features.map((f, i) => (
                  <div
                    key={f}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '16px 0',
                      borderTop: '1px solid var(--hl-rule-hairline)',
                      ...(i === p.features.length - 1 ? { borderBottom: '1px solid var(--hl-rule-hairline)' } : null),
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--hl-ink)" aria-hidden="true">
                      <rect width="8" height="8" />
                    </svg>
                    <span style={{ fontSize: 15, color: 'var(--hl-ink-2)' }}>{f}</span>
                  </div>
                ))}
              </div>
              <Button href={APP} variant={p.variant} ground="light" style={{ marginTop: 24, width: '100%' }}>
                {p.cta}
              </Button>
            </div>
          ))}
        </div>

        <p style={{ ...bodyStyle, marginTop: 40, fontSize: 14, lineHeight: '22px', color: 'var(--hl-ink-3)' }}>
          Every plan is billed {billedWord} and cancels from the dashboard. No run-based surprise bills — rows per
          run are the only meter, and a failed run is never metered.
        </p>
      </Container>
    </section>
  );
}

type Billing = 'm' | 'a';

type Plan = {
  num: string;
  name: string;
  monthly: string;
  annual: string;
  description: string;
  features: string[];
  cta: string;
  recommended?: boolean;
  solid?: boolean;
};

const PLANS: Plan[] = [
  {
    num: '01',
    name: 'Free',
    monthly: '$0',
    annual: '$0',
    description: 'For the first pipeline you draw on a Sunday afternoon.',
    features: ['1 project', '2 workflows', '100k rows per run', 'Community support'],
    cta: 'Start free',
  },
  {
    num: '02',
    name: 'Pro',
    monthly: '$19',
    annual: '$190',
    description: 'For the analyst who now has a schedule to keep.',
    features: ['10 projects', '25 workflows', '1M rows per run', 'Email support'],
    cta: 'Start with Pro',
  },
  {
    num: '03',
    name: 'Organization',
    monthly: '$99',
    annual: '$990',
    description: 'For the team where somebody else has to be able to read it.',
    features: ['Seats and roles', 'Unlimited projects and workflows', '50M rows per run', 'SSO and activity log'],
    cta: 'Start with your team',
    recommended: true,
    solid: true,
  },
];

// PRICING (as on the live site). Port of designs/nia-hero/index.html lines
// 430-477, driven by billing/setBilling from useNiaHeroEngine instead of
// the reference's own setState (renderVals() lines 767-774).
export default function Pricing({ billing, setBilling }: { billing: Billing; setBilling: (b: Billing) => void }) {
  const annual = billing === 'a';
  const per = annual ? '/ year' : '/ month';

  return (
    <section id="pricing" aria-labelledby="nx-pricing-h" style={{ background: '#F8FAFC', color: '#0F172A', padding: '72px max(20px, 8vw) 64px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 44 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
          <h2 id="nx-pricing-h" className="nx-cap">
            Three plans · billed {annual ? 'annually' : 'monthly'}
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 22 }}>
            <span style={{ fontSize: 14, color: '#64748B' }}>Two months free on annual</span>
            <div role="group" aria-label="Billing period" style={{ display: 'flex', border: '1px solid #CBD5E1', background: '#FFFFFF' }}>
              <button
                type="button"
                aria-pressed={!annual}
                onClick={() => setBilling('m')}
                style={{ minHeight: 42, padding: '0 20px', border: 0, background: annual ? 'transparent' : '#0A0A0B', color: annual ? '#0F172A' : '#FFFFFF', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}
              >
                Monthly
              </button>
              <button
                type="button"
                aria-pressed={annual}
                onClick={() => setBilling('a')}
                style={{ minHeight: 42, padding: '0 20px', border: 0, background: annual ? '#0A0A0B' : 'transparent', color: annual ? '#FFFFFF' : '#0F172A', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}
              >
                Annual
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
          {PLANS.map((p) => (
            <div key={p.num} className="nx-plan">
              {p.recommended ? (
                <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#64748B' }}>
                  <span>{p.num}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.16em', color: '#4F46E5' }}>RECOMMENDED</span>
                </span>
              ) : (
                <span style={{ fontSize: 13, color: '#64748B' }}>{p.num}</span>
              )}
              <h3 style={{ margin: '22px 0 0', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>{p.name}</h3>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 14 }}>
                <span style={{ fontSize: 58, fontWeight: 300, lineHeight: 1, letterSpacing: '-0.04em' }}>{annual ? p.annual : p.monthly}</span>
                <span style={{ fontSize: 15, color: '#475569' }}>{per}</span>
              </div>
              <p style={{ margin: '16px 0 0', minHeight: '3.2em', fontSize: 15, lineHeight: 1.6, color: '#1E293B' }}>{p.description}</p>
              <ul style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, borderTop: '1px solid #E2E8F0', flexGrow: 1 }}>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <a
                href="#"
                style={{
                  marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 50,
                  textDecoration: 'none', fontSize: 15, fontWeight: 500,
                  ...(p.solid
                    ? { background: '#0A0A0B', color: '#FFFFFF' }
                    : { border: '1.5px solid #0F172A', color: '#0F172A' }),
                }}
              >
                {p.cta}
              </a>
            </div>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#475569' }}>
          Every plan is billed monthly and cancels from the dashboard. No run-based surprise bills — rows per run are the only meter, and a failed run is never metered.
        </p>
      </div>
    </section>
  );
}

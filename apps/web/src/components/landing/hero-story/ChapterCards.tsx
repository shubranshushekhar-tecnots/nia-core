const EXTRACT_LOGOS = ['postgresql', 'mysql', 'sql-server', 'mongodb', 'oracle', 'redis', 'amazon-s3', 'salesforce'];
const EXTRACT_ALTS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  'sql-server': 'SQL Server',
  mongodb: 'MongoDB',
  oracle: 'Oracle',
  redis: 'Redis',
  'amazon-s3': 'Amazon S3',
  salesforce: 'Salesforce',
};

function cardStyle(cVar: string) {
  return {
    gridArea: '1 / 1', background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 14,
    padding: '28px 30px', display: 'flex', flexDirection: 'column' as const, gap: 16,
    opacity: `calc(${cVar} * 40)`,
    clipPath: `inset(calc((1 - ${cVar}) * 100%) 0 0 0 round 14px)`,
    transform: `translateY(calc((1 - ${cVar}) * 16px))`,
  };
}

function Eyebrow({ num, label }: { num: string; label: string }) {
  return (
    <span className="nx-mono" style={{ fontSize: 11, color: '#64748B' }}>
      <span style={{ color: '#4F46E5' }}>{num}</span> / 04 · {label}
    </span>
  );
}

function Headline({ children, accent }: { children: string; accent: string }) {
  return (
    <h2 style={{ margin: 0, fontWeight: 300, fontSize: 'clamp(1.9rem, 2.8vw, 2.6rem)', lineHeight: 1.04, letterSpacing: '-0.04em' }}>
      {children} <span style={{ color: '#4F46E5' }}>{accent}</span>
    </h2>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#0F172A' }} />;
}

// CHAPTER CARDS — the stacked copy cards riding the stage words. Port of
// designs/nia-hero/index.html lines 348-397.
export default function ChapterCards() {
  return (
    <div className="nx-card" style={{ display: 'grid' }}>
      <div style={cardStyle('var(--c1, 0)')}>
        <Eyebrow num="01" label="Extract" />
        <Headline accent="lives.">Read it where it</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          Databases, warehouses, files and SaaS apps through built‑in connectors. Authenticate once with a read‑only role and reuse it in every pipeline you draw.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {EXTRACT_LOGOS.map((logo) => (
            <span key={logo} className="lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/landing/logos/${logo}.svg`} alt={EXTRACT_ALTS[logo]} />
            </span>
          ))}
          <span className="nx-mono" style={{ fontSize: 11, color: '#64748B', paddingLeft: 4 }}>60+ connectors</span>
        </div>
      </div>

      <div style={cardStyle('var(--c2, 0)')}>
        <Eyebrow num="01" label="Extract · Nia Agent" />
        <Headline accent="Never in.">Out through the firewall.</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          For databases on your own network, the Nia Agent runs on Windows, macOS or Linux, pairs with a one‑time code and only makes outgoing connections.
        </p>
      </div>

      <div style={cardStyle('var(--c3, 0)')}>
        <Eyebrow num="02" label="Transform" />
        <Headline accent="matters.">Keep only what</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          A rule like <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: '#0F172A' }}>branch = North</span> filters the stream before anything lands.
        </p>
      </div>

      <div style={cardStyle('var(--c4, 0)')}>
        <Eyebrow num="02" label="Transform" />
        <Headline accent="moves.">Only what changed</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          After the first run, only new or changed rows travel. Never the whole table again.
        </p>
      </div>

      <div style={cardStyle('var(--c5, 0)')}>
        <Eyebrow num="03" label="Move" />
        <Headline accent="way.">Sealed the whole</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          Credentials are stored encrypted, every workspace&rsquo;s data is kept separate, and a guard blocks any run that would delete more than 20%.
        </p>
      </div>

      <div style={cardStyle('var(--c6, 0)')}>
        <Eyebrow num="04" label="Load" />
        <Headline accent="half‑done.">Nothing lands</Headline>
        <Divider />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#475569' }}>
          Rows land wherever you point them: warehouses like Snowflake and BigQuery, BI tools, sheets or SaaS apps. Only in destinations you&rsquo;ve allowed, on demand or on a schedule.
        </p>
      </div>
    </div>
  );
}

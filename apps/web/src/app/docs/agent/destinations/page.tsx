import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeBlockStyle,
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export default function DestinationsPage() {
  return (
    <DocsLayout
      title="Destinations"
      seeAlso={[
        { href: '/docs/agent/local-database-canvas', label: 'Use a local database on the Canvas' },
        { href: '/docs/agent/security', label: 'Security' },
      ]}
    >
      <div style={nxDocsNoticeStyle}>
        A local database job can deliver to a Planometry table or an HTTPS endpoint — not yet to
        other destinations.
      </div>

      <section>
        <h2 style={nxDocsH2Style}>Planometry table</h2>
        <p style={nxDocsPStyle}>
          A destination connection pointing at a Planometry table URL and API key, created the
          same way as any other connection on Nia Core. Because Planometry&apos;s schema is
          introspectable, the usual mapping editor works unchanged — map source columns to
          Planometry&apos;s fields just like mapping to any other connector.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>HTTPS endpoint</h2>
        <p style={nxDocsPStyle}>
          An address you control, plus how to authenticate to it (an API key, a bearer token, or
          basic auth). An arbitrary endpoint has no schema to introspect, so mapping falls back to
          entering target field names by hand.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Allowing a destination on the agent</h2>
        <p style={nxDocsPStyle}>
          For a job published from a Nia Core workflow, the agent will refuse to deliver anywhere
          that isn&apos;t on its own local allow-list — this covers Planometry&apos;s address and
          any HTTPS endpoint equally. A workflow can&apos;t quietly start sending your data
          somewhere new; you decide what&apos;s reachable, on the agent machine itself:
        </p>
        <pre style={nxDocsCodeBlockStyle}>{`nia-agent destinations allow <destination-hostname>
nia-agent destinations list
nia-agent destinations remove <destination-hostname>`}</pre>
        <p style={nxDocsPStyle}>
          If a published job&apos;s destination host isn&apos;t allowed, the agent rejects it
          locally with &quot;destination not on local allow-list&quot; — visible on the{' '}
          <a href="/docs/agent/monitoring" style={{ color: 'var(--nx-ink)' }}>
            Agents page
          </a>
          .
        </p>
        <p style={nxDocsPStyle}>
          Jobs created directly on the agent machine with{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent job add</span> aren&apos;t affected by this
          list.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>What gets sent where</h2>
        <ul style={nxDocsListStyle}>
          <li>The agent sends the actual rows straight to the job&apos;s destination — Nia
            Core&apos;s platform never sees row data.</li>
          <li>Nia Core only receives a status summary: job name, source table, destination type
            and host, schedule, and health — plus, per run, success/failure, row count, duration,
            and (on failure) a general error category, never the detailed error text.</li>
        </ul>
        <p style={nxDocsPStyle}>
          Full detail in{' '}
          <a href="/docs/agent/security" style={{ color: 'var(--nx-ink)' }}>
            Security
          </a>
          .
        </p>
      </section>
    </DocsLayout>
  );
}

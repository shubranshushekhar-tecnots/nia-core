import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export default function GettingStartedPage() {
  return (
    <DocsLayout
      title="Getting started"
      seeAlso={[
        { href: '/docs/agent/install-windows', label: 'Install on Windows' },
        { href: '/docs/agent/connect-database', label: 'Connect a database' },
        { href: '/docs/agent/local-database-canvas', label: 'Use a local database on the Canvas' },
      ]}
    >
      <p style={nxDocsPStyle}>
        Nia Core Agent is a small program your IT team runs on a machine inside your own network.
        It lets Nia Core read your databases and deliver data without your database ever being
        reachable from the outside. Here is the whole journey, in five steps.
      </p>

      <section>
        <h2 style={nxDocsH2Style}>1. Get a pairing code (on the Nia Core platform)</h2>
        <p style={nxDocsPStyle}>
          An admin, owner, or member with access to this workspace opens the Agents page and
          clicks &quot;Add agent.&quot; This creates a one-time pairing code to hand to whoever
          runs the install on the machine.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>2. Download and run the installer (on your machine)</h2>
        <p style={nxDocsPStyle}>
          From the{' '}
          <a href="/downloads" style={{ color: 'var(--nx-ink)' }}>
            downloads page
          </a>
          , get the package for your operating system and run it. See the install guide for your
          OS for the exact click-through steps.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>3. Answer the guided setup (on your machine)</h2>
        <p style={nxDocsPStyle}>
          The installer walks you through a short set of questions: your pairing code, your
          database&apos;s server address and port, a username and password for it, which
          databases to read, and your timezone. See{' '}
          <a href="/docs/agent/connect-database" style={{ color: 'var(--nx-ink)' }}>
            Connect a database
          </a>{' '}
          for what to have ready beforehand.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>4. Confirm it checked in (on the Nia Core platform)</h2>
        <p style={nxDocsPStyle}>
          Once the agent starts, it shows up on the Agents page as online within a few seconds.
          That confirms the pairing worked and the platform can reach it.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>5. Build your first job (on the Nia Core platform)</h2>
        <p style={nxDocsPStyle}>
          On the Canvas, add a &quot;Local database (via agent)&quot; connection, pick a table,
          map its fields, choose a destination, and publish. See{' '}
          <a href="/docs/agent/local-database-canvas" style={{ color: 'var(--nx-ink)' }}>
            Use a local database on the Canvas
          </a>
          .
        </p>
      </section>

      <div style={nxDocsNoticeStyle}>
        Today the agent connects to Microsoft SQL Server, and a local database job can only
        deliver to a Planometry table or an HTTPS endpoint. The Profile tab and Run checks are not
        available yet for these jobs.
      </div>

      <ul style={nxDocsListStyle}>
        <li>
          Need the exact commands instead of the guided questions? Each install guide has an{' '}
          <span style={nxDocsCodeChipStyle}>Advanced</span> section with the typed version.
        </li>
      </ul>
    </DocsLayout>
  );
}

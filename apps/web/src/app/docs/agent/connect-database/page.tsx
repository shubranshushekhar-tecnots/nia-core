import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeBlockStyle,
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export default function ConnectDatabasePage() {
  return (
    <DocsLayout
      title="Connect a database"
      seeAlso={[
        { href: '/docs/agent/local-database-canvas', label: 'Use a local database on the Canvas' },
        { href: '/docs/agent/security', label: 'Security' },
      ]}
    >
      <div style={nxDocsNoticeStyle}>Today the agent connects to Microsoft SQL Server only.</div>

      <section>
        <h2 style={nxDocsH2Style}>What you need</h2>
        <ul style={nxDocsListStyle}>
          <li>The database server&apos;s address and port (default <span style={nxDocsCodeChipStyle}>1433</span>).</li>
          <li>The name of the database to read.</li>
          <li>A read-only username and password. If you don&apos;t have one yet, see below.</li>
          <li>The IANA time zone the database server itself runs in (for example{' '}
            <span style={nxDocsCodeChipStyle}>America/New_York</span>) — not necessarily the
            agent machine&apos;s own time zone.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Generating a read-only login</h2>
        <p style={nxDocsPStyle}>
          During guided setup, leaving the username blank offers to write a setup script for your
          DBA instead. The same thing, typed directly:
        </p>
        <pre style={nxDocsCodeBlockStyle}>nia-agent sql readonly --login nia_agent --databases &lt;your-database-name&gt; --out nia-readonly-setup.sql</pre>
        <p style={nxDocsPStyle}>
          Use a comma-separated list for <span style={nxDocsCodeChipStyle}>--databases</span> if
          the agent will read more than one database on the same server. This writes a script for
          your DBA to review and run themselves — the agent never runs it. It creates one login
          with a placeholder password the DBA replaces, grants it read access to the listed
          database(s) plus the ability to see table and column definitions, and grants no write
          access of any kind — enforced automatically. Safe to run more than once.
        </p>
        <p style={nxDocsPStyle}>Optional flags:</p>
        <ul style={nxDocsListStyle}>
          <li><span style={nxDocsCodeChipStyle}>--schema &lt;name&gt;</span> — restrict to one
            schema instead of the whole database.</li>
          <li><span style={nxDocsCodeChipStyle}>--with-cancel-visibility true</span> — one
            additional, still read-only, permission letting the agent confirm a stopped query
            actually stopped. Off by default.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Adding the connection</h2>
        <p style={nxDocsPStyle}>
          Through the guided setup (<span style={nxDocsCodeChipStyle}>nia-agent setup</span>),
          this is asked as a sequence of questions. Typed directly:
        </p>
        <pre style={nxDocsCodeBlockStyle}>{`nia-agent connection add \\
  --id <short-id> --label "<friendly name>" \\
  --host <database-server-host> --port <port> --database <database-name> \\
  --user nia_agent --password <the-password> \\
  --source-timezone <IANA time zone, e.g. America/New_York>`}</pre>
        <p style={nxDocsPStyle}>
          The password is encrypted immediately and never stored in plain text. If your database
          only accepts unencrypted connections on your local network, add{' '}
          <span style={nxDocsCodeChipStyle}>--encrypt false</span>. Only use{' '}
          <span style={nxDocsCodeChipStyle}>--allow-legacy-tls true</span> if your DBA has
          confirmed the server cannot negotiate a modern TLS version.
        </p>
        <p style={nxDocsPStyle}>
          Confirm it works: <span style={nxDocsCodeChipStyle}>nia-agent connection test &lt;short-id&gt;</span>.
          A failure here is almost always a network, host/port, or credentials problem.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Adding more databases later</h2>
        <p style={nxDocsPStyle}>
          Run <span style={nxDocsCodeChipStyle}>nia-agent setup</span> again and choose &quot;add
          another database&quot; from its menu, or run{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent connection add</span> again by hand with a
          different <span style={nxDocsCodeChipStyle}>--id</span>.
        </p>
      </section>
    </DocsLayout>
  );
}

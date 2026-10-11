import type { Metadata } from 'next';
import { CodeBlock } from '@/components/docs/CodeBlock';
import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsButtonNameStyle,
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export const metadata: Metadata = {
  title: 'Install on Windows',
  description: 'Run the installer, answer the guided setup questions, verify it checked in.',
};

export default function InstallWindowsPage() {
  return (
    <DocsLayout
      title="Install on Windows"
      seeAlso={[
        { href: '/docs/agent/connect-database', label: 'Connect a database' },
        { href: '/docs/agent/monitoring', label: 'Monitoring and control' },
      ]}
    >
      <section>
        <h2 style={nxDocsH2Style}>Before you start</h2>
        <ul style={nxDocsListStyle}>
          <li>A pairing code or pairing command from the Agents page (ask an admin for it).</li>
          <li>Network access from this machine to your database server.</li>
          <li>A read-only database login, if you already have one — otherwise the setup can
            generate a script for your DBA to create one.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Install</h2>
        <ol style={nxDocsListStyle}>
          <li>
            Download and double-click <span style={nxDocsCodeChipStyle}>NiaCoreAgent-Setup-&lt;version&gt;.exe</span>{' '}
            from the{' '}
            <a href="/downloads" style={{ color: 'var(--nx-ink)' }}>
              downloads page
            </a>
            .
          </li>
          <li>
            Approve the single admin prompt, choose an install folder (or accept the default),
            and click through to <strong>Finish</strong>. Leave <strong>&quot;Set up now&quot;</strong> checked.
          </li>
          <li>The guided setup opens automatically in a console window — answer its questions below.</li>
        </ol>
        <p style={nxDocsPStyle}>
          That&apos;s it. The agent installs as a Windows service, running under its own
          restricted account (not an administrator), and starts automatically from then on. Find{' '}
          <strong>&quot;Nia Core Agent Setup&quot;</strong> and <strong>&quot;Nia Core Agent Status&quot;</strong>{' '}
          in the Start Menu any time you need to run the wizard again or check in.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Guided setup questions</h2>
        <ol style={nxDocsListStyle}>
          <li>Pairing command or code — paste the full command from the Agents page, or just the code.</li>
          <li>Database server and port (default <span style={nxDocsCodeChipStyle}>1433</span>). If
            it detects SQL Server instances on this machine, it lists them first and picking one
            (pressing Enter takes the first) is the default — <span style={nxDocsCodeChipStyle}>localhost</span>{' '}
            is offered last, as a fallback if none are detected or none match.</li>
          <li>Database username — leave blank if you don&apos;t have one yet, and it offers to
            write a read-only setup script for your DBA instead.</li>
          <li>Database password (hidden as you type).</li>
          <li>Pick a database from a numbered list of what that login can see.</li>
          <li>Time zone the database server runs in (defaults to this machine&apos;s own).</li>
          <li>Destination hostname to allow (optional — only needed if a job will be published
            from a Nia Core workflow rather than added directly on this machine).</li>
        </ol>
        <p style={nxDocsPStyle}>
          It then starts the service, waits for a successful check-in, and prints a summary. Run
          the wizard again any time from the Start Menu shortcut — once already set up, it shows
          a small menu instead (add another database, test a database, allow a destination, show
          status, exit).
        </p>
      </section>

      <div style={nxDocsNoticeStyle}>
        This installer is not code-signed yet. Windows SmartScreen will say &quot;Windows
        protected your PC&quot; the first time — click <span style={nxDocsButtonNameStyle}>More info</span>, then{' '}
        <span style={nxDocsButtonNameStyle}>Run anyway</span>.
      </div>

      <section>
        <h2 style={nxDocsH2Style}>Verify it worked</h2>
        <p style={nxDocsPStyle}>
          Open the Agents page on Nia Core — the agent should show up as online within a few
          seconds of finishing setup. On the machine itself, run{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent status</span> for how long it has been
          running, whether it is paired, when it last checked in, and the health of each job.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Uninstall</h2>
        <p style={nxDocsPStyle}>
          Use <strong>Settings &rarr; Apps &rarr; Nia Core Agent &rarr; Uninstall</strong> — it
          asks whether to keep or delete the agent&apos;s stored configuration.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Advanced: typed-command install</h2>
        <p style={nxDocsPStyle}>
          Everything the guided setup does can also be done by hand — useful for scripted or
          unattended installs. Install without the guided setup with:
        </p>
        <CodeBlock code="powershell -ExecutionPolicy Bypass -File install.ps1" />
        <p style={nxDocsPStyle}>
          run as Administrator from the unzipped bundle folder. This does not start the agent —
          run <span style={nxDocsCodeChipStyle}>Start-Service nia-agent</span> afterward. Then, in
          order:
        </p>
        <CodeBlock code={`nia-agent sql readonly --login nia_agent --databases <your-database-name> --out nia-readonly-setup.sql

nia-agent pair --code <pairing-code> --url <platform-address>

nia-agent connection add \\
  --id <short-id> --label "<friendly name>" \\
  --host <database-server-host> --port <port> --database <database-name> \\
  --user nia_agent --password <the-password> \\
  --source-timezone <IANA time zone, e.g. America/New_York>

nia-agent destinations allow <destination-hostname>

nia-agent status`} />
        <p style={nxDocsPStyle}>
          The read-only setup script creates one login with a placeholder password your DBA
          replaces, grants it read access plus the ability to see table/column definitions, and
          grants no write access of any kind — enforced automatically. Confirm a connection works
          with <span style={nxDocsCodeChipStyle}>nia-agent connection test &lt;short-id&gt;</span>.
        </p>
      </section>
    </DocsLayout>
  );
}

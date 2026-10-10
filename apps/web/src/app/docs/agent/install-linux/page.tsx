import type { Metadata } from 'next';
import { CodeBlock } from '@/components/docs/CodeBlock';
import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export const metadata: Metadata = {
  title: 'Install on Linux',
  description: 'Unpack, run the guided setup, start the agent, verify it checked in.',
};

export default function InstallLinuxPage() {
  return (
    <DocsLayout
      title="Install on Linux"
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
          <li>Root access, to run the installer and register the <span style={nxDocsCodeChipStyle}>systemd</span> service.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Install</h2>
        <ol style={nxDocsListStyle}>
          <li>
            Download <span style={nxDocsCodeChipStyle}>nia-core-agent-linux-&lt;version&gt;.tar.gz</span>{' '}
            onto the target machine from the{' '}
            <a href="/downloads" style={{ color: 'var(--nx-ink)' }}>
              downloads page
            </a>
            .
          </li>
          <li>
            Run, as root:
            <CodeBlock code="sudo ./install.sh nia-core-agent-linux-<version>.tar.gz" />
          </li>
          <li>
            When it asks <strong>&quot;Run guided setup now? [Y/n]&quot;</strong>, press Enter and
            answer its questions below.
          </li>
        </ol>
        <p style={nxDocsPStyle}>
          That&apos;s it. The agent runs under a dedicated, unprivileged system account as a{' '}
          <span style={nxDocsCodeChipStyle}>systemd</span> service, starting automatically going
          forward.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Guided setup questions</h2>
        <ol style={nxDocsListStyle}>
          <li>Pairing command or code — paste the full command from the Agents page, or just the code.</li>
          <li>Database server (default <span style={nxDocsCodeChipStyle}>localhost</span>) and port
            (default <span style={nxDocsCodeChipStyle}>1433</span>).</li>
          <li>Database username — leave blank if you don&apos;t have one yet, and it offers to
            write a read-only setup script for your DBA instead.</li>
          <li>Database password (hidden as you type).</li>
          <li>Pick a database from a numbered list of what that login can see.</li>
          <li>Time zone the database server runs in (defaults to this machine&apos;s own).</li>
          <li>Destination hostname to allow (optional — only needed if a job will be published
            from a Nia Core workflow rather than added directly on this machine).</li>
        </ol>
        <p style={nxDocsPStyle}>
          It then starts the service, waits for a successful check-in, and prints a summary. Run{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent setup</span> again any time — once already
          set up, it shows a small menu instead.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Verify it worked</h2>
        <p style={nxDocsPStyle}>
          Open the Agents page on Nia Core — the agent should show up as online within a few
          seconds. On the machine itself, run{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent status</span>.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Uninstall</h2>
        <CodeBlock code="sudo ./uninstall.sh" />
        <p style={nxDocsPStyle}>
          Add <span style={nxDocsCodeChipStyle}>--purge</span> to also remove stored configuration.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Advanced: typed-command install</h2>
        <p style={nxDocsPStyle}>
          <span style={nxDocsCodeChipStyle}>sudo ./install.sh nia-core-agent-linux-&lt;version&gt;.tar.gz</span>{' '}
          does not start the agent by itself — run{' '}
          <span style={nxDocsCodeChipStyle}>sudo systemctl start nia-agent</span> afterward. Then,
          in order:
        </p>
        <CodeBlock code={`nia-agent sql readonly --login nia_agent --databases <your-database-name> --out nia-readonly-setup.sql

nia-agent pair --code <pairing-code> --url <platform-address>

nia-agent connection add \\
  --id <short-id> --label "<friendly name>" \\
  --host <database-server-host> --port <port> --database <database-name> \\
  --user nia_agent --password <the-password> \\
  --source-timezone <IANA time zone, e.g. America/New_York>

nia-agent destinations allow <destination-hostname>

nia-agent status`}
        />
      </section>
    </DocsLayout>
  );
}

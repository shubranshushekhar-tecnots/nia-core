import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeBlockStyle,
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export default function InstallMacosPage() {
  return (
    <DocsLayout
      title="Install on macOS"
      seeAlso={[
        { href: '/docs/agent/connect-database', label: 'Connect a database' },
        { href: '/docs/agent/monitoring', label: 'Monitoring and control' },
      ]}
    >
      <div style={nxDocsNoticeStyle}>
        Apple Silicon (M1 or newer) only. This build is ad-hoc signed, not signed with an Apple
        Developer ID, so Gatekeeper will refuse to open it on first run — see the step below for
        how to allow it.
      </div>

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
            Download and unzip <span style={nxDocsCodeChipStyle}>nia-agent-macos-arm64-&lt;version&gt;.zip</span>{' '}
            from the{' '}
            <a href="/downloads" style={{ color: 'var(--nx-ink)' }}>
              downloads page
            </a>
            .
          </li>
          <li>Open Terminal in the unzipped folder and run <span style={nxDocsCodeChipStyle}>./install.sh</span>.</li>
          <li>
            When it asks <strong>&quot;Run guided setup now? [Y/n]&quot;</strong>, press Enter and
            answer its questions below.
          </li>
        </ol>
        <p style={nxDocsPStyle}>
          That&apos;s it. The agent runs under your own macOS user account (no administrator
          rights needed), starts immediately, and restarts itself at login or if it ever stops
          unexpectedly.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Running an unsigned build</h2>
        <p style={nxDocsPStyle}>
          Gatekeeper will say &quot;nia-agent&quot; cannot be opened because the developer cannot
          be verified. To run it anyway: open{' '}
          <strong>System Settings &rarr; Privacy &amp; Security</strong> after the first blocked
          attempt and click <strong>Open Anyway</strong>, or run this once before installing:
        </p>
        <pre style={nxDocsCodeBlockStyle}>xattr -d com.apple.quarantine ./nia-agent</pre>
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
          It then confirms a successful check-in and prints a summary. Run{' '}
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
        <pre style={nxDocsCodeBlockStyle}>./uninstall.sh</pre>
        <p style={nxDocsPStyle}>
          Add <span style={nxDocsCodeChipStyle}>--purge</span> to also remove stored configuration
          and logs.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Advanced: typed-command install</h2>
        <p style={nxDocsPStyle}>
          Install without the guided setup with{' '}
          <span style={nxDocsCodeChipStyle}>./install.sh</span> (or{' '}
          <span style={nxDocsCodeChipStyle}>sudo ./install.sh --system</span> for a system-wide
          service for all users, starting at boot) — it starts immediately either way. Then, in
          order:
        </p>
        <pre style={nxDocsCodeBlockStyle}>{`nia-agent sql readonly --login nia_agent --databases <your-database-name> --out nia-readonly-setup.sql

nia-agent pair --code <pairing-code> --url <platform-address>

nia-agent connection add \\
  --id <short-id> --label "<friendly name>" \\
  --host <database-server-host> --port <port> --database <database-name> \\
  --user nia_agent --password <the-password> \\
  --source-timezone <IANA time zone, e.g. America/New_York>

nia-agent destinations allow <destination-hostname>

nia-agent status`}</pre>
      </section>
    </DocsLayout>
  );
}

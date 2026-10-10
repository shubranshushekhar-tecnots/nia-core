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
  title: 'Troubleshooting and uninstalling',
  description: 'Common problems and how to remove the agent, per operating system.',
};

export default function TroubleshootingPage() {
  return (
    <DocsLayout
      title="Troubleshooting and uninstalling"
      seeAlso={[
        { href: '/docs/agent/monitoring', label: 'Monitoring and control' },
        { href: '/docs/agent/connect-database', label: 'Connect a database' },
      ]}
    >
      <section>
        <h2 style={nxDocsH2Style}>General troubleshooting</h2>
        <ul style={nxDocsListStyle}>
          <li>
            Run <span style={nxDocsCodeChipStyle}>nia-agent status</span> first — it reports how
            long the agent has been running, whether it&apos;s paired, when it last checked in,
            and the health of each job.
          </li>
          <li>
            A database connection failure is almost always a network, host/port, or credentials
            problem — confirm with{' '}
            <span style={nxDocsCodeChipStyle}>nia-agent connection test &lt;short-id&gt;</span>.
          </li>
          <li>
            If a job won&apos;t run, check its error class on the Agents page or in{' '}
            <span style={nxDocsCodeChipStyle}>nia-agent status</span> — see{' '}
            <a href="/docs/agent/monitoring" style={{ color: 'var(--nx-ink)' }}>
              Monitoring and control
            </a>{' '}
            for what each one means and what to do.
          </li>
          <li>
            If the agent isn&apos;t showing up on the Agents page at all, confirm it has outbound
            HTTPS access to the Nia Core platform address — no inbound ports are ever needed.
          </li>
          <li>
            A published job rejected with &quot;destination not on local allow-list&quot; needs{' '}
            <span style={nxDocsCodeChipStyle}>nia-agent destinations allow &lt;hostname&gt;</span>{' '}
            run on the agent machine.
          </li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Uninstall on Windows</h2>
        <p style={nxDocsPStyle}>
          Use <strong>Settings &rarr; Apps &rarr; Nia Core Agent &rarr; Uninstall</strong> — it
          asks whether to keep or delete the agent&apos;s stored configuration.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Uninstall on macOS</h2>
        <CodeBlock code="./uninstall.sh" />
        <p style={nxDocsPStyle}>
          Add <span style={nxDocsCodeChipStyle}>--purge</span> to also remove stored configuration
          and logs.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Uninstall on Linux</h2>
        <CodeBlock code="sudo ./uninstall.sh" />
        <p style={nxDocsPStyle}>
          Add <span style={nxDocsCodeChipStyle}>--purge</span> to also remove stored configuration.
        </p>
      </section>

      <p style={nxDocsPStyle}>
        Uninstalling doesn&apos;t revoke the agent on the platform side — do that separately from
        the Agents page if the machine is being retired. See{' '}
        <a href="/docs/agent/security" style={{ color: 'var(--nx-ink)' }}>
          Security
        </a>
        .
      </p>
    </DocsLayout>
  );
}

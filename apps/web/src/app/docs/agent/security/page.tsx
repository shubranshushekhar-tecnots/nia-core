import type { Metadata } from 'next';
import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export const metadata: Metadata = {
  title: 'Security',
  description: 'What leaves your network, what never does, the allow-list, revoking access.',
};

export default function SecurityPage() {
  return (
    <DocsLayout
      title="Security"
      seeAlso={[
        { href: '/docs/agent/destinations', label: 'Destinations' },
        { href: '/docs/agent/connect-database', label: 'Connect a database' },
      ]}
    >
      <section>
        <h2 style={nxDocsH2Style}>The two ways a job can be set up</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>Direct delivery</strong> — a job created on the agent machine itself,
            pointing straight at a destination (Planometry or an HTTPS address you control).</li>
          <li><strong>Through a Nia Core workflow</strong> — a job designed on the Canvas and
            published down to the agent to run.</li>
        </ul>
        <p style={nxDocsPStyle}>
          In both cases, the agent reads your database and sends the resulting rows{' '}
          <strong>directly</strong> to the job&apos;s destination — row data never passes through
          Nia Core&apos;s platform either way. The only difference is who defines and manages the
          job: with a published workflow, Nia Core also receives a status summary; with a job
          created directly on the agent, Nia Core never sees it unless you publish it.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>What Nia Core&apos;s platform receives</h2>
        <p style={nxDocsPStyle}>
          Only small, non-sensitive status information, sent when the agent checks in:
        </p>
        <ul style={nxDocsListStyle}>
          <li>That the agent is alive, and its version and host name.</li>
          <li>For each job: its name, which table it reads, where it sends to (destination type
            and host — not the full address with any path or query string), its schedule, and its
            current health.</li>
          <li>For each run: success/failure, row count, duration, and — on failure — a general
            error category, never the specific error text.</li>
        </ul>
        <p style={nxDocsPStyle}>
          That&apos;s it. No row values, column values, filter values, or parameter values ever
          appear in this check-in traffic.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>What never leaves your network</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>Your database password.</strong> Encrypted and stored only on the agent
            machine — never sent to Nia Core, Planometry, or any HTTPS destination.</li>
          <li><strong>The actual rows, on the direct-delivery route.</strong> Nia Core&apos;s
            platform never sees row data, whether or not that job is also visible in Nia Core
            because it was published there.</li>
          <li>Any detailed rejection or error message text from a destination. That stays in the
            agent&apos;s own local logs and status, for your team&apos;s troubleshooting.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>How you stay in control</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>The allow-list.</strong> For jobs published from a workflow, the agent
            refuses to deliver anywhere not on an allow-list you maintain on the agent machine
            (<span style={nxDocsCodeChipStyle}>nia-agent destinations allow/list/remove</span>). A
            workflow can&apos;t quietly start sending your data somewhere new — you decide
            what&apos;s reachable.</li>
          <li><strong>Unpair.</strong> <span style={nxDocsCodeChipStyle}>nia-agent unpair</span>{' '}
            immediately removes the agent&apos;s link to Nia Core. It keeps running any jobs you
            set up directly on it, but stops checking in and can&apos;t receive anything published
            from a workflow.</li>
          <li><strong>Revoke.</strong> Nia Core can revoke an agent&apos;s access from its side at
            any time — for example, if a machine is decommissioned. A revoked agent is rejected
            the next time it tries to check in. Available on the Agents page to admins, owners,
            and the person who paired it.</li>
        </ul>
      </section>
    </DocsLayout>
  );
}

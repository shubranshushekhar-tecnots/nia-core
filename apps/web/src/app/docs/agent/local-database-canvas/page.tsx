import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsNoticeStyle,
  nxDocsPStyle,
} from '@/components/docs/styles';

export default function LocalDatabaseCanvasPage() {
  return (
    <DocsLayout
      title="Use a local database on the Canvas"
      seeAlso={[
        { href: '/docs/agent/destinations', label: 'Destinations' },
        { href: '/docs/agent/monitoring', label: 'Monitoring and control' },
      ]}
    >
      <div style={nxDocsNoticeStyle}>
        Today this connection type reads from Microsoft SQL Server only, and a job built this way
        can only deliver to a Planometry table or an HTTPS endpoint. The Profile tab and Run
        checks are not yet available for these jobs. Any transform step other than a simple
        filter (computed fields, aggregates, flattening, dropping fields) isn&apos;t supported on
        this path — route those through a regular Nia Core workflow instead.
      </div>

      <section>
        <h2 style={nxDocsH2Style}>1. Add the connection</h2>
        <p style={nxDocsPStyle}>
          On the Canvas, add a new connection and choose <strong>&quot;Local database (via
          agent)&quot;</strong>. Pick the paired agent and, if it has more than one, which
          database connection on that agent to use. There are no host, username, or password
          fields here — those live on the agent machine, set up during install (see{' '}
          <a href="/docs/agent/connect-database" style={{ color: 'var(--nx-ink)' }}>
            Connect a database
          </a>
          ).
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>2. Test and browse</h2>
        <p style={nxDocsPStyle}>
          Use <strong>Test</strong> to confirm the platform can reach the agent and the agent can
          reach the database — this only checks reachability, it doesn&apos;t run anything.
          Browse the database&apos;s tables the same way as any other connection.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>3. Pick a table and columns</h2>
        <p style={nxDocsPStyle}>
          Choose the table to read. List the exact columns you want — this connection type never
          reads every column by default, only what you explicitly pick.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>4. Add a filter (optional)</h2>
        <p style={nxDocsPStyle}>
          A simple filter (column compared to a value, chained with AND) is supported. If a
          filter is too complex for direct delivery — it uses OR, NOT, or a computed condition —
          Publish will block with a plain message telling you to route it through a regular Nia
          Core workflow instead.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>5. Map fields and choose the key</h2>
        <p style={nxDocsPStyle}>
          On the destination node&apos;s Mapping tab, map each source column to its destination
          field, the same mapping editor used everywhere else on the Canvas. In the Delivery
          section, choose the key column(s) the destination uses to match rows, and — if the mode
          needs one — a watermark column (a column that increases over time, used to find new or
          changed rows).
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>6. Delivery settings</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>Mode</strong> — replace (resend everything each run), upsertDelta (send only
            new/changed rows, matched by key), or realtime.</li>
          <li><strong>Watermark column</strong> — required for upsertDelta/realtime, to find what
            changed since the last run.</li>
          <li><strong>Delete method and safety</strong> — how to treat rows missing a key value,
            whether an empty-source replace is allowed, and a maximum-delete-percentage guard
            against an accidental mass delete.</li>
          <li><strong>Schedule</strong> — how often the job runs, or how often it polls in
            realtime mode.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>7. Publish</h2>
        <p style={nxDocsPStyle}>
          <strong>Publish</strong> is the one action that actually sends this job to the agent —
          saving the Canvas graph does not. Publish shows you a diff against whatever is currently
          running on the agent, and clearly flags anything that forces a full reload (switching
          the source table, changing the key or watermark column, or switching away from
          upsertDelta/realtime mode) versus a change the agent can apply in place (schedule,
          mapping, filter value). Confirm to send it.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>8. Run now, and other actions</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>Run now</strong> — runs the job once immediately, optionally overriding its
            current parameter values for that run only; it does not change the published setup.</li>
          <li><strong>Force full reload</strong> — runs once, resetting the watermark, regardless
            of the job&apos;s normal mode.</li>
          <li><strong>Pause / Resume</strong> — stops or restarts the job&apos;s own schedule.</li>
          <li><strong>Allow one large delete</strong> — a one-time confirmation when a run would
            exceed the configured max-delete-percentage safety guard.</li>
        </ul>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>9. Reading run history</h2>
        <p style={nxDocsPStyle}>
          Runs for a job set up this way appear both in the owning workflow&apos;s own run history
          and on the{' '}
          <a href="/docs/agent/monitoring" style={{ color: 'var(--nx-ink)' }}>
            Agents page
          </a>
          , showing success/failure, row counts, how long each run took, and — for a failed run —
          its error class.
        </p>
      </section>

      <p style={nxDocsPStyle}>
        <span style={nxDocsCodeChipStyle}>nia-agent status</span> on the agent machine shows the
        same jobs from that side, including any created directly on the agent with{' '}
        <span style={nxDocsCodeChipStyle}>nia-agent job add</span> rather than published from the
        Canvas — those are listed as &quot;local&quot; and stay fully agent-owned.
      </p>
    </DocsLayout>
  );
}

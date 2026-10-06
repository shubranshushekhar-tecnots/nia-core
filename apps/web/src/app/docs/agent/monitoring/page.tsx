import { DocsLayout } from '@/components/docs/DocsLayout';
import {
  nxDocsCodeChipStyle,
  nxDocsH2Style,
  nxDocsListStyle,
  nxDocsPStyle,
  nxDocsTableStyle,
  nxDocsTdStyle,
  nxDocsThStyle,
} from '@/components/docs/styles';

export default function MonitoringPage() {
  return (
    <DocsLayout
      title="Monitoring and control"
      seeAlso={[
        { href: '/docs/agent/local-database-canvas', label: 'Use a local database on the Canvas' },
        { href: '/docs/agent/troubleshooting', label: 'Troubleshooting and uninstalling' },
      ]}
    >
      <section>
        <h2 style={nxDocsH2Style}>The Agents page</h2>
        <p style={nxDocsPStyle}>
          Lists every agent paired to this workspace: its online status (based on when it last
          checked in), its version, and its jobs — both published from a Nia Core workflow and
          any created directly on the agent machine (shown marked &quot;local&quot;, with status
          and run history visible but no remote controls, since those stay fully agent-owned).
          For a published job, you can also see the version the platform wants it running versus
          the version the agent has actually applied, and why, if it rejected an update.
        </p>
        <p style={nxDocsPStyle}>
          On the agent machine itself,{' '}
          <span style={nxDocsCodeChipStyle}>nia-agent status</span> shows the same information
          from that side: how long the agent has been running, whether it&apos;s paired, when it
          last checked in, and the health of each job.
        </p>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Job health</h2>
        <table style={nxDocsTableStyle}>
          <thead>
            <tr>
              <th style={nxDocsThStyle}>Status</th>
              <th style={nxDocsThStyle}>Meaning</th>
              <th style={nxDocsThStyle}>What to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={nxDocsTdStyle}>ok</td>
              <td style={nxDocsTdStyle}>Running on schedule, no unresolved failure.</td>
              <td style={nxDocsTdStyle}>Nothing.</td>
            </tr>
            <tr>
              <td style={nxDocsTdStyle}>failing</td>
              <td style={nxDocsTdStyle}>The most recent run(s) failed, but the agent is still retrying automatically on schedule.</td>
              <td style={nxDocsTdStyle}>Check the error class for that run; most clear up on their own.</td>
            </tr>
            <tr>
              <td style={nxDocsTdStyle}>paused</td>
              <td style={nxDocsTdStyle}>The agent stopped running this job automatically.</td>
              <td style={nxDocsTdStyle}>Fix the underlying issue, then Resume.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Last run result</h2>
        <table style={nxDocsTableStyle}>
          <thead>
            <tr>
              <th style={nxDocsThStyle}>Result</th>
              <th style={nxDocsThStyle}>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={nxDocsTdStyle}>completed</td><td style={nxDocsTdStyle}>The run finished and sent its rows successfully.</td></tr>
            <tr><td style={nxDocsTdStyle}>failed</td><td style={nxDocsTdStyle}>The run did not complete — see its error class below.</td></tr>
            <tr><td style={nxDocsTdStyle}>skipped</td><td style={nxDocsTdStyle}>A scheduled run was skipped — either the job is paused, or the previous run of the same job was still in progress. Not an error.</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Error classes and what to do</h2>
        <p style={nxDocsPStyle}>
          &quot;Pauses&quot; means the job stops running until you Resume it; everything else keeps
          retrying on its normal schedule (some get fast automatic retries too).
        </p>
        <table style={nxDocsTableStyle}>
          <thead>
            <tr>
              <th style={nxDocsThStyle}>Error class</th>
              <th style={nxDocsThStyle}>What it means</th>
              <th style={nxDocsThStyle}>Pauses?</th>
              <th style={nxDocsThStyle}>What to do</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={nxDocsTdStyle}>config</td><td style={nxDocsTdStyle}>The job&apos;s own setup is invalid — e.g. the destination rejected the credentials, or a required setting is missing.</td><td style={nxDocsTdStyle}>Yes</td><td style={nxDocsTdStyle}>Fix the destination credentials/settings, Test, then Resume.</td></tr>
            <tr><td style={nxDocsTdStyle}>schemaDrift</td><td style={nxDocsTdStyle}>The destination&apos;s columns have changed since this job was set up.</td><td style={nxDocsTdStyle}>Yes</td><td style={nxDocsTdStyle}>Review what changed, update the mapping, Test, then Resume.</td></tr>
            <tr><td style={nxDocsTdStyle}>typeMismatch</td><td style={nxDocsTdStyle}>A value didn&apos;t fit the type the destination expects for that column.</td><td style={nxDocsTdStyle}>Yes</td><td style={nxDocsTdStyle}>Check the source column and mapping, fix the mismatch, then Resume.</td></tr>
            <tr><td style={nxDocsTdStyle}>nullKey</td><td style={nxDocsTdStyle}>A row had a missing or blank key value, and the job is set to stop rather than skip it.</td><td style={nxDocsTdStyle}>Yes</td><td style={nxDocsTdStyle}>Clean up the data, or allow skipping null-key rows, then Resume.</td></tr>
            <tr><td style={nxDocsTdStyle}>massDelete</td><td style={nxDocsTdStyle}>A sync would delete a larger share of destination rows than allowed.</td><td style={nxDocsTdStyle}>Yes</td><td style={nxDocsTdStyle}>Confirm the deletion is expected, raise the limit or use &quot;Allow one large delete,&quot; then Resume.</td></tr>
            <tr><td style={nxDocsTdStyle}>transient</td><td style={nxDocsTdStyle}>A network problem, or a temporary error from the destination.</td><td style={nxDocsTdStyle}>No — retries at 1, 5, and 15 minutes</td><td style={nxDocsTdStyle}>Usually nothing; if it persists, check connectivity.</td></tr>
            <tr><td style={nxDocsTdStyle}>diskSpace</td><td style={nxDocsTdStyle}>The agent&apos;s local staging area is low on free disk space.</td><td style={nxDocsTdStyle}>No — retries at 1, 5, and 15 minutes</td><td style={nxDocsTdStyle}>Free up disk space on the agent machine.</td></tr>
            <tr><td style={nxDocsTdStyle}>lockTaken</td><td style={nxDocsTdStyle}>Another sync against the same database server was already running.</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Nothing — it tries again next scheduled run.</td></tr>
            <tr><td style={nxDocsTdStyle}>rejected</td><td style={nxDocsTdStyle}>The destination flatly rejected the request (not a temporary one).</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Check the destination settings; contact support with the job ID and timestamp if unclear.</td></tr>
            <tr><td style={nxDocsTdStyle}>mismatch</td><td style={nxDocsTdStyle}>The destination reported a different row count than what was sent.</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Usually transient; contact support if it recurs for the same job.</td></tr>
            <tr><td style={nxDocsTdStyle}>emptyReplace</td><td style={nxDocsTdStyle}>A full-reload run found zero rows, and the job isn&apos;t configured to allow that.</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Confirm the source has data, or allow empty replace once, then re-run.</td></tr>
            <tr><td style={nxDocsTdStyle}>aborted</td><td style={nxDocsTdStyle}>The run was stopped mid-way — e.g. the agent restarted. Not a real failure.</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Nothing — it runs again on schedule.</td></tr>
            <tr><td style={nxDocsTdStyle}>other</td><td style={nxDocsTdStyle}>Anything outside the classes above.</td><td style={nxDocsTdStyle}>No</td><td style={nxDocsTdStyle}>Check the error message; contact support if it recurs.</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={nxDocsH2Style}>Controls</h2>
        <ul style={nxDocsListStyle}>
          <li><strong>Pause / Resume</strong> — stop or restart a job&apos;s schedule.</li>
          <li><strong>Run now</strong> — run once immediately, with optional one-time parameter overrides.</li>
          <li><strong>Force full reload</strong> — run once, ignoring the normal mode, resending everything.</li>
        </ul>
      </section>
    </DocsLayout>
  );
}

import type { ConsoleSystemHealth } from '@/lib/api/consoleServer';
import StatusPill from './StatusPill';
import {
  consoleContentStyle,
  consoleEmptyStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleSectionTitleStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatValueStyle,
  consoleStatsRowStyle,
} from './styles';
import {
  consoleHealthMigrationRowStyle,
  consoleHealthQueueListStyle,
  consoleHealthQueueNameStyle,
  consoleHealthQueueRowStyle,
  consoleHealthQueueStatLabelStyle,
  consoleHealthQueueStatStyle,
  consoleHealthQueueStatValueStyle,
  consoleHealthSectionStyle,
} from './healthStyles';

/**
 * Console redesign plan's Slice 4 — System Health page. Server-rendered
 * platform-wide snapshot (no filters/reload, same "fixed, unfiltered"
 * shape as ConsoleDashboardClient), reached via ConsoleShell's 'health'
 * nav entry. Composes: API/worker/connector/migration status cards, a
 * failed-runs-24h stat, and a per-queue backlog list.
 *
 * Worker status is read from BullMQ's `Queue.getWorkers()` (confirmed live
 * against this project's own dev Redis to reliably reflect a connected
 * worker process) — no heartbeat fallback was needed, see
 * apps/api/src/services/consoleHealth.ts's doc comment.
 */
export default function ConsoleHealthClient({ data }: { data: ConsoleSystemHealth }) {
  const { api, worker, queues, failedRuns24h, connectors, latestMigration } = data;

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <h1 style={consoleHeaderTitleStyle}>System Health</h1>
          <span style={consoleHeaderSubStyle}>API, worker, queue, and connector status across the platform.</span>
        </div>
      </div>

      <div style={consoleStatsRowStyle}>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>API</span>
          <StatusPill tone={api === 'ok' ? 'success' : 'error'} label={api === 'ok' ? 'Healthy' : 'Down'} />
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Worker</span>
          <StatusPill
            tone={worker.status === 'healthy' ? 'success' : 'error'}
            label={worker.status === 'healthy' ? `Healthy (${worker.count})` : 'No workers'}
          />
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Failed runs (24h)</span>
          <span style={consoleStatValueStyle}>{failedRuns24h.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Connectors</span>
          <StatusPill
            tone={connectors.error > 0 ? 'error' : 'success'}
            label={`${connectors.ok} ok / ${connectors.error} error / ${connectors.untested} untested`}
          />
        </div>
      </div>

      <div style={consoleHealthSectionStyle}>
        <h3 style={consoleSectionTitleStyle}>Queue backlog</h3>
        <div style={consoleHealthQueueListStyle}>
          {queues.map((q) => (
            <div key={q.name} style={consoleHealthQueueRowStyle}>
              <span style={consoleHealthQueueNameStyle}>{q.name}</span>
              <div style={consoleHealthQueueStatStyle}>
                <span style={consoleHealthQueueStatLabelStyle}>Waiting</span>
                <span style={consoleHealthQueueStatValueStyle}>{q.waiting.toLocaleString()}</span>
              </div>
              <div style={consoleHealthQueueStatStyle}>
                <span style={consoleHealthQueueStatLabelStyle}>Active</span>
                <span style={consoleHealthQueueStatValueStyle}>{q.active.toLocaleString()}</span>
              </div>
              <div style={consoleHealthQueueStatStyle}>
                <span style={consoleHealthQueueStatLabelStyle}>Delayed</span>
                <span style={consoleHealthQueueStatValueStyle}>{q.delayed.toLocaleString()}</span>
              </div>
              <div style={consoleHealthQueueStatStyle}>
                <span style={consoleHealthQueueStatLabelStyle}>Failed</span>
                <span style={consoleHealthQueueStatValueStyle}>{q.failed.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={consoleHealthSectionStyle}>
        <h3 style={consoleSectionTitleStyle}>Latest migration</h3>
        {latestMigration ? (
          <div style={consoleHealthMigrationRowStyle}>
            <span>{latestMigration.version}</span>
            <span>{latestMigration.name}</span>
            <span>{new Date(latestMigration.finishedAt).toLocaleString()}</span>
          </div>
        ) : (
          <div style={consoleEmptyStyle}>No migrations recorded.</div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listAgentSetupRuns,
  requestAgentSetupAction,
  AgentSetupApiError,
  type AgentSetupActionKind,
  type AgentSetupJobState,
  type AgentSetupRun,
} from '@/lib/api/agentSetupClient';
import {
  nxModalBodyStyle,
  nxModalBodyTextStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalDangerCellStyle,
  nxModalErrorStyle,
  nxModalFieldRowStackedStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalTitleStyle,
} from '@/components/app/styles';
import { headerRunChecksCellStyle } from './styles';

/**
 * Agent-Canvas integration, Slice R5a (docs/plans/agent-canvas-integration.md
 * B.7/B.8) — the live job state + action buttons + run history for a
 * published agent-delivered workflow. Rendered by FlowCanvas.tsx directly
 * below CanvasHeader (not inside it — that header's row is a tightly
 * tuned fixed-width cell layout, see CanvasHeader.tsx's UI-10 comments;
 * this panel only ever appears once a setup is actually applied, so it
 * never competes with that row for space). Viewers (readOnly) see the
 * state line and the run history list but none of the action buttons.
 */

const PLAIN_ERROR_CLASS: Record<string, string> = {
  massDelete: 'paused — a run would delete an unusually large share of rows',
  config: 'a configuration problem',
  transient: 'a temporary error — the agent will retry',
  credentials: 'a credentials problem',
};

function plainErrorClass(errorClass: string | null): string | null {
  if (!errorClass) return null;
  return PLAIN_ERROR_CLASS[errorClass] ?? errorClass;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 20px',
  borderBottom: '1px solid var(--nx-line)',
  background: 'var(--nx-raised)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const dimStyle: CSSProperties = { fontSize: 12, color: 'var(--nx-ink-3)' };

function badgeStyle(state: AgentSetupJobState['state'] | undefined): CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 'var(--nx-radius)',
    border: '1px solid var(--nx-line)',
    color: state === 'failing' ? 'var(--nx-danger-text)' : state === 'ok' ? 'var(--nx-success-text, var(--nx-ink))' : 'var(--nx-ink-3)',
    background: state === 'failing' ? 'var(--nx-danger-tint)' : 'transparent',
    textTransform: 'capitalize',
  };
}

const linkButtonStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--nx-ink-3)',
  fontSize: 12,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
};

const historyListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 220,
  overflowY: 'auto',
  fontSize: 12,
};

const historyRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 90px 100px 100px 70px 1fr',
  gap: 8,
  padding: '4px 0',
  borderBottom: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-3)',
};

function runResultLabel(run: AgentSetupRun): string {
  if (run.status === 'ok') return 'OK';
  return plainErrorClass(run.errorClass) ?? 'Failed';
}

function RunHistoryList({ workflowId, open }: { workflowId: string; open: boolean }) {
  const runsQuery = useQuery({
    queryKey: ['agent-setup-runs', workflowId],
    queryFn: () => listAgentSetupRuns(workflowId),
    enabled: open,
    // A run's report reaches the platform asynchronously (the agent sends
    // it on its next check-in, not the instant the run finishes) — poll
    // while open so a run that completes just after this panel was opened
    // still shows up without the user having to close and reopen it.
    refetchInterval: open ? 3_000 : false,
  });

  if (!open) return null;

  return (
    <div style={historyListStyle}>
      {runsQuery.isLoading && <span style={dimStyle}>Loading…</span>}
      {runsQuery.error && <span style={nxModalErrorStyle}>Couldn&apos;t load run history.</span>}
      {runsQuery.data?.length === 0 && <span style={dimStyle}>No runs yet.</span>}
      {runsQuery.data?.map((run) => (
        <div key={run.id} style={historyRowStyle}>
          <span>{formatTime(run.startedAt)}</span>
          <span>{run.mode ?? '—'}</span>
          <span>{run.rowsSent.toLocaleString()} sent</span>
          <span>{run.rowsDeleted.toLocaleString()} deleted</span>
          <span>{run.durationMs < 1000 ? 'under 1s' : `${(run.durationMs / 1000).toFixed(1)}s`}</span>
          <span style={run.status === 'failed' ? { color: 'var(--nx-danger-text)' } : undefined}>{runResultLabel(run)}</span>
        </div>
      ))}
    </div>
  );
}

function RunNowDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (params: Record<string, string>) => Promise<void> }) {
  const [paramsText, setParamsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      for (const line of paramsText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        params[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
      await onConfirm(params);
    } catch (err) {
      setError(err instanceof AgentSetupApiError ? err.message : "Couldn't start this run.");
      setSubmitting(false);
    }
  };

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={nxModalBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}>
            <span style={nxModalTitleStyle}>Run now?</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>
              The agent runs this job on its next check-in. Leave the box below empty to run with its saved parameters, or override one-off
              values, one <code>key=value</code> per line.
            </p>
            <div style={nxModalFieldRowStackedStyle}>
              <span style={nxModalLabelStyle}>Parameter overrides — leave empty to use saved values</span>
              <textarea
                value={paramsText}
                onChange={(e) => setParamsText(e.target.value)}
                rows={4}
                style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 12.5, padding: 8, border: '1px solid var(--nx-line)', borderRadius: 'var(--nx-radius)', background: 'var(--nx-bg)', color: 'var(--nx-ink)' }}
                placeholder="Example: since=2024-01-01"
              />
            </div>
            {error && <span style={nxModalErrorStyle}>{error}</span>}
          </div>
        </div>
        <div style={nxModalFooterStyle}>
          <button type="button" style={nxModalCancelCellStyle} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="nx-wipe"
            style={{ ...nxModalDangerCellStyle(submitting), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? 'Starting…' : 'Run now'}
          </button>
        </div>
      </div>
    </div>
  );
}

type ConfirmKind = 'full_reload' | 'allow_mass_delete';

function ConfirmActionDialog({
  kind,
  massDeleteRowCount,
  onClose,
  onConfirm,
}: {
  kind: ConfirmKind;
  massDeleteRowCount: number | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof AgentSetupApiError ? err.message : "Couldn't do that. Try again.");
      setSubmitting(false);
    }
  };

  const title = kind === 'full_reload' ? 'Force a full reload?' : 'Allow one large delete?';
  const body =
    kind === 'full_reload'
      ? 'The agent re-sends every row from the source table on its next run, instead of only what changed.'
      : massDeleteRowCount !== null
        ? `The agent last reported this run would remove ${massDeleteRowCount.toLocaleString()} row(s). Allowing it lets one run through the mass-delete guard.`
        : 'The agent has not reported how many rows this would remove. Allowing it lets one run through the mass-delete guard regardless.';

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={nxModalBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}>
            <span style={nxModalTitleStyle}>{title}</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>{body}</p>
            {error && <span style={nxModalErrorStyle}>{error}</span>}
          </div>
        </div>
        <div style={nxModalFooterStyle}>
          <button type="button" style={nxModalCancelCellStyle} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="nx-wipe"
            style={{ ...nxModalDangerCellStyle(submitting), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentJobPanel({
  workflowId,
  jobState,
  readOnly,
  onActionDone,
}: {
  workflowId: string;
  jobState: AgentSetupJobState | null;
  readOnly: boolean;
  onActionDone: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runNowOpen, setRunNowOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const [busy, setBusy] = useState<AgentSetupActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Loaded (not just on open) once the setup is paused by the mass-delete
  // guard, so the allow-one-large-delete confirmation can state the row
  // count from the most recent failed run without the user having to open
  // the history list first.
  const pausedByMassDelete = jobState?.state === 'paused' && jobState.errorClass === 'massDelete';
  const runsForConfirm = useQuery({
    queryKey: ['agent-setup-runs', workflowId],
    queryFn: () => listAgentSetupRuns(workflowId),
    enabled: pausedByMassDelete,
  });
  const massDeleteRowCount = useMemo(() => {
    const failed = runsForConfirm.data?.find((run) => run.status === 'failed' && run.errorClass === 'massDelete');
    return failed ? failed.rowsDeleted : null;
  }, [runsForConfirm.data]);

  const runAction = async (kind: AgentSetupActionKind, extra?: { params?: Record<string, string>; confirm?: boolean }) => {
    setBusy(kind);
    setActionError(null);
    try {
      await requestAgentSetupAction(workflowId, { kind, ...extra });
      onActionDone();
    } catch (err) {
      setActionError(err instanceof AgentSetupApiError ? err.message : "Couldn't do that. Try again.");
      throw err;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <span style={badgeStyle(jobState?.state)} title={jobState ? plainErrorClass(jobState.errorClass) ?? jobState.state : 'No reports yet'}>
          {jobState ? jobState.state : 'No reports yet'}
        </span>
        {jobState?.errorClass && <span style={dimStyle}>{plainErrorClass(jobState.errorClass)}</span>}
        <span style={dimStyle}>Last run: {formatTime(jobState?.lastRunAt)}</span>
        <span style={dimStyle}>Next run: {formatTime(jobState?.nextRunAt)}</span>
        <button type="button" onClick={() => setHistoryOpen((v) => !v)} style={linkButtonStyle}>
          {historyOpen ? 'Hide run history' : 'Run history'}
        </button>
      </div>

      {!readOnly && (
        <div style={rowStyle}>
          <button
            type="button"
            className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
            disabled={busy !== null}
            onClick={() => void runAction('test').catch(() => undefined)}
            style={headerRunChecksCellStyle}
          >
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
            disabled={busy !== null}
            onClick={() => setRunNowOpen(true)}
            style={headerRunChecksCellStyle}
          >
            Run now
          </button>
          <button
            type="button"
            className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
            disabled={busy !== null}
            onClick={() => setConfirmKind('full_reload')}
            style={headerRunChecksCellStyle}
          >
            Full reload
          </button>
          <button
            type="button"
            className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
            disabled={busy !== null}
            onClick={() => void runAction('pause').catch(() => undefined)}
            style={headerRunChecksCellStyle}
          >
            {busy === 'pause' ? 'Pausing…' : 'Pause'}
          </button>
          <button
            type="button"
            className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
            disabled={busy !== null}
            onClick={() => void runAction('resume').catch(() => undefined)}
            style={headerRunChecksCellStyle}
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
          {pausedByMassDelete && (
            <button
              type="button"
              className={busy ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
              disabled={busy !== null}
              onClick={() => setConfirmKind('allow_mass_delete')}
              style={headerRunChecksCellStyle}
            >
              Allow one large delete
            </button>
          )}
        </div>
      )}

      {actionError && <span style={nxModalErrorStyle}>{actionError}</span>}

      <RunHistoryList workflowId={workflowId} open={historyOpen} />

      {runNowOpen && (
        <RunNowDialog
          onClose={() => setRunNowOpen(false)}
          onConfirm={async (params) => {
            await runAction('run_now', Object.keys(params).length > 0 ? { params } : undefined);
            setRunNowOpen(false);
          }}
        />
      )}

      {confirmKind && (
        <ConfirmActionDialog
          kind={confirmKind}
          massDeleteRowCount={massDeleteRowCount}
          onClose={() => setConfirmKind(null)}
          onConfirm={async () => {
            await runAction(confirmKind, confirmKind === 'allow_mass_delete' ? { confirm: true } : undefined);
            setConfirmKind(null);
          }}
        />
      )}
    </div>
  );
}

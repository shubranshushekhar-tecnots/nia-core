'use client';

import type { CheckResult, CheckStatus } from '@nia/schemas';
import type { ActivityItem } from '@/lib/canvas/activityFeed';

/**
 * Full-width bottom dock for the canvas (Phase 5 Session 3 Task 2
 * completion pass) — replaces CheckResultsPanel.tsx's right-anchored
 * dropdown. "Logs" went live in Session 4 — merged check-run + chat-query
 * feed from activityFeed.ts; a `kind: 'run'` source joins it once Phase 6's
 * execution SSE-replay channel exists.
 *
 * Collapse/expand is driven entirely by the summary pill ("All checks
 * passed ⌄" / "N failing ⌄" / "Checks out of date ⌄"), which doubles as
 * the dock's only toggle control — there's no separate chevron button.
 * Tab selection (Checks/Logs) is independent of that expand state.
 */

const dockStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  borderTop: '1px solid var(--line2)',
  boxShadow: '0 -4px 16px rgba(15,23,42,.08)',
} as const;

const barStyle = {
  height: 40,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 12px',
} as const;

const tabStyle = (active: boolean) =>
  ({
    fontSize: 12,
    fontWeight: 600,
    color: active ? 'var(--ink)' : 'var(--ink4)',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid var(--acc)' : '2px solid transparent',
    padding: '10px 10px 8px',
    cursor: active ? 'default' : 'pointer',
  }) as const;

const logRowStyle = {
  display: 'flex',
  gap: 10,
  padding: '5px 0',
  borderBottom: '1px solid var(--line)',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
} as const;

const bodyStyle = {
  maxHeight: 260,
  overflowY: 'auto',
  borderTop: '1px solid var(--line2)',
  padding: '8px 16px',
} as const;

const STATUS_STYLES: Record<CheckStatus, { color: string; bg: string; label: string }> = {
  pass: { color: 'var(--ok)', bg: 'var(--ok-bg)', label: 'Pass' },
  fail: { color: 'var(--bad)', bg: 'var(--bad-bg)', label: 'Fail' },
  warn: { color: 'var(--warn)', bg: 'var(--warn-bg)', label: 'Warn' },
};

type PillTone = 'ok' | 'bad' | 'warn' | 'neutral';

const PILL_TONE_STYLES: Record<PillTone, { color: string; bg: string; border: string }> = {
  ok: { color: 'var(--ok)', bg: 'var(--ok-bg)', border: 'var(--ok)' },
  bad: { color: 'var(--bad)', bg: 'var(--bad-bg)', border: 'var(--bad)' },
  warn: { color: 'var(--warn)', bg: 'var(--warn-bg)', border: 'var(--warn-bd)' },
  neutral: { color: 'var(--ink4)', bg: 'var(--surface2)', border: 'var(--line2)' },
};

function ResultRow({ result, onSelect }: { result: CheckResult; onSelect: (nodeId: string) => void }) {
  const s = STATUS_STYLES[result.status];
  const clickable = result.status === 'fail' && !!result.nodeId;
  return (
    <div
      onClick={clickable ? () => onSelect(result.nodeId!) : undefined}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span
        style={{
          flex: 'none',
          fontSize: 10,
          fontWeight: 600,
          color: s.color,
          background: s.bg,
          borderRadius: 999,
          padding: '2px 7px',
          marginTop: 1,
        }}
      >
        {s.label}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>{result.message}</div>
        <div style={{ fontSize: 10.5, color: 'var(--ink4)', marginTop: 1 }}>
          {result.id}
          {result.nodeId ? ` · ${result.nodeId}` : ''}
          {clickable ? ' · click to locate' : ''}
        </div>
      </div>
    </div>
  );
}

export default function ChecksDock({
  running,
  error,
  results,
  ranAt,
  stale,
  expanded,
  onToggleExpanded,
  onSelectNode,
  activeTab,
  onTabChange,
  logs,
}: {
  running: boolean;
  error: string | null;
  results: CheckResult[] | null;
  ranAt: string | null;
  /** True when latestCheckRun.graphVersion no longer matches the live graph version. */
  stale: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelectNode: (nodeId: string) => void;
  activeTab: 'checks' | 'logs';
  onTabChange: (tab: 'checks' | 'logs') => void;
  logs: ActivityItem[];
}) {
  const failingChecks = results?.filter((r) => r.status === 'fail').length ?? 0;

  let pillLabel: string;
  let pillTone: PillTone;
  if (running) {
    pillLabel = 'Running checks…';
    pillTone = 'neutral';
  } else if (error) {
    pillLabel = 'Check run failed';
    pillTone = 'bad';
  } else if (!results) {
    pillLabel = 'No checks have run yet';
    pillTone = 'neutral';
  } else if (stale) {
    pillLabel = 'Checks out of date — re-run';
    pillTone = 'warn';
  } else if (failingChecks > 0) {
    pillLabel = `${failingChecks} failing`;
    pillTone = 'bad';
  } else {
    pillLabel = 'All checks passed';
    pillTone = 'ok';
  }
  const pillStyle = PILL_TONE_STYLES[pillTone];

  return (
    <div style={dockStyle} data-testid="checks-dock">
      {expanded && activeTab === 'checks' && (
        <div style={bodyStyle} data-testid="checks-dock-body">
          {running && <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>Running checks…</div>}
          {!running && error && <div style={{ fontSize: 12.5, color: 'var(--bad)' }}>{error}</div>}
          {!running && !error && results && results.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>No checks ran.</div>
          )}
          {!running && !error && results && results.length > 0 && (
            <div>
              {results.map((r, i) => (
                <ResultRow key={`${r.id}-${r.nodeId ?? ''}-${i}`} result={r} onSelect={onSelectNode} />
              ))}
              {ranAt && (
                <div style={{ fontSize: 10.5, color: 'var(--ink4)', marginTop: 8 }}>
                  Last run {new Date(ranAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
          {!running && !error && !results && (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>No checks have run yet.</div>
          )}
        </div>
      )}

      {expanded && activeTab === 'logs' && (
        <div style={bodyStyle} data-testid="checks-dock-logs">
          {logs.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>Run logs arrive with execution (Phase 6)</div>
          ) : (
            logs.map((l, i) => (
              <div key={`${l.kind}-${l.time}-${i}`} style={logRowStyle}>
                <span style={{ flex: 'none', color: 'var(--ink4)' }}>{new Date(l.time).toLocaleString()}</span>
                <span style={{ color: 'var(--ink2)' }}>{l.text}</span>
              </div>
            ))
          )}
        </div>
      )}

      <div style={barStyle}>
        <button
          type="button"
          style={tabStyle(activeTab === 'checks')}
          onClick={() => {
            onTabChange('checks');
            if (!expanded) onToggleExpanded();
          }}
        >
          Checks
        </button>
        <button
          type="button"
          style={tabStyle(activeTab === 'logs')}
          onClick={() => {
            onTabChange('logs');
            if (!expanded) onToggleExpanded();
          }}
        >
          Logs
        </button>

        <button
          type="button"
          onClick={onToggleExpanded}
          data-testid="checks-dock-pill"
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            fontWeight: 600,
            color: pillStyle.color,
            background: pillStyle.bg,
            border: `1px solid ${pillStyle.border}`,
            borderRadius: 999,
            padding: '4px 12px',
            cursor: 'pointer',
          }}
        >
          {pillLabel} {expanded ? '\u2303' : '\u2304'}
        </button>
      </div>
    </div>
  );
}

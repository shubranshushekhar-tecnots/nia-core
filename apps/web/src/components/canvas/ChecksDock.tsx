'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CheckResult, CheckStatus } from '@nia/schemas';
import type { ActivityItem } from '@/lib/canvas/activityFeed';
import { dragHandleStyle } from './styles';

/**
 * Full-width bottom dock for the canvas (Phase 5 Session 3 Task 2
 * completion pass) — replaces CheckResultsPanel.tsx's right-anchored
 * dropdown. "Logs" went live in Session 4 — merged check-run + chat-query
 * feed from activityFeed.ts; Phase 6 Block 3.5 added the `kind: 'run'`
 * source (FlowCanvas.tsx's own live run-stream events, throttled).
 *
 * Collapse/expand is driven entirely by the summary pill ("All checks
 * passed ⌄" / "N failing ⌄" / "Checks out of date ⌄"), which doubles as
 * the dock's only toggle control — there's no separate chevron button.
 * Tab selection (Checks/Logs) is independent of that expand state.
 *
 * Canvas redesign: split into two named exports — `ChecksBar` (the
 * always-mounted 36px collapsed strip: tabs, pass/fail/skip counts, a mono
 * "N NODES · M EDGES · last run" meta line, and the pill) and
 * `ChecksDrawer` (the expanded resizable Checks/Logs body). The default
 * `ChecksDock` export composes both and still owns all the drag/height
 * state — FlowCanvas.tsx's call site is unchanged.
 */

const dockStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  // Clip to canvas-surface's own box — barStyle's row content (tabs, meta
  // line, counts, pill) has no wrap/shrink, so without this it can overflow
  // past this container's right edge and visually spill onto whatever sits
  // to the right (CopilotSidebar/CommandBar) at narrow canvas-surface widths.
  overflow: 'hidden',
  background: 'var(--surface)',
  borderTop: '1px solid var(--line2)',
  boxShadow: '0 -4px 16px rgba(15,23,42,.08)',
} as const;

// 36px collapsed (redesign spec) — this is also the whole dock's height
// while collapsed, since the body row below is unmounted in that state.
const DOCK_BAR_HEIGHT = 36;
const DOCK_BODY_DEFAULT_HEIGHT = 260;
const DOCK_BODY_MIN_HEIGHT = 120;
const DOCK_BODY_MAX_HEIGHT = 480;
// Below MIN, the body keeps shrinking down to this visual floor instead of
// snapping — dragging past it (release below COLLAPSE_THRESHOLD) fully
// collapses the dock so it stops covering node popups. Lets a drag do what
// used to require a separate click on the summary pill.
const DOCK_BODY_DRAG_FLOOR = 24;
const DOCK_BODY_COLLAPSE_THRESHOLD = 80;

const barStyle = {
  height: DOCK_BAR_HEIGHT,
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
    flex: 'none',
    whiteSpace: 'nowrap',
  }) as const;

const logRowStyle = {
  display: 'flex',
  gap: 10,
  padding: '5px 0',
  borderBottom: '1px solid var(--line)',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
} as const;

function bodyStyleFor(height: number) {
  return {
    height,
    overflowY: 'auto',
    borderTop: '1px solid var(--line2)',
    padding: '8px 16px',
  } as const;
}

const STATUS_STYLES: Record<CheckStatus, { color: string; bg: string; label: string }> = {
  pass: { color: 'var(--ok)', bg: 'var(--ok-bg)', label: 'Pass' },
  fail: { color: 'var(--bad)', bg: 'var(--bad-bg)', label: 'Fail' },
  warn: { color: 'var(--warn)', bg: 'var(--warn-bg)', label: 'Warn' },
  // 'skip' (canvas redesign) — a check that never applied (e.g. a
  // same-connector mapping path), rendered neutral, never counted as a
  // pass or a failure.
  skip: { color: 'var(--ink4)', bg: 'var(--surface2)', label: 'Skip' },
};

type PillTone = 'ok' | 'bad' | 'warn' | 'neutral';

const PILL_TONE_STYLES: Record<PillTone, { color: string; bg: string; border: string }> = {
  ok: { color: 'var(--ok)', bg: 'var(--ok-bg)', border: 'var(--ok)' },
  bad: { color: 'var(--bad)', bg: 'var(--bad-bg)', border: 'var(--bad)' },
  warn: { color: 'var(--warn)', bg: 'var(--warn-bg)', border: 'var(--warn-bd)' },
  neutral: { color: 'var(--ink4)', bg: 'var(--surface2)', border: 'var(--line2)' },
};

// Failing rows sort first (then warn, then pass, then skip) so the most
// actionable results never scroll below a wall of passes.
const STATUS_SORT_RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };
function sortResults(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status]);
}

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
        padding: '6px 8px',
        margin: '0 -8px',
        borderRadius: 6,
        // Failing rows get a tinted background so they read as
        // actionable at a glance, even once sorted to the top of a
        // long, otherwise-passing list.
        background: result.status === 'fail' ? 'var(--bad-bg)' : 'transparent',
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

/**
 * ChecksDrawer — the expanded, resizable body (Checks/Logs tab content +
 * the drag handle). Split out of the single ChecksDock render tree so the
 * always-mounted 36px ChecksBar below stays a small, easily-scanned
 * component of its own; both are still driven by the same drag/height
 * state, owned by the default ChecksDock export.
 */
export function ChecksDrawer({
  running,
  error,
  results,
  ranAt,
  activeTab,
  logs,
  onSelectNode,
  bodyHeight,
  dragging,
  onDragPointerDown,
}: {
  running: boolean;
  error: string | null;
  results: CheckResult[] | null;
  ranAt: string | null;
  activeTab: 'checks' | 'logs';
  logs: ActivityItem[];
  onSelectNode: (nodeId: string) => void;
  bodyHeight: number;
  dragging: boolean;
  onDragPointerDown: (e: ReactPointerEvent) => void;
}) {
  const sorted = results ? sortResults(results) : null;
  return (
    <div style={{ position: 'relative' }}>
      <div style={dragHandleStyle('horizontal', dragging)} onPointerDown={onDragPointerDown} data-testid="checks-dock-drag-handle" />
      {activeTab === 'checks' && (
        <div style={bodyStyleFor(bodyHeight)} data-testid="checks-dock-body">
          {running && <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>Running checks…</div>}
          {!running && error && <div style={{ fontSize: 12.5, color: 'var(--bad)' }}>{error}</div>}
          {!running && !error && sorted && sorted.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>No checks ran.</div>
          )}
          {!running && !error && sorted && sorted.length > 0 && (
            <div>
              {sorted.map((r, i) => (
                <ResultRow key={`${r.id}-${r.nodeId ?? ''}-${i}`} result={r} onSelect={onSelectNode} />
              ))}
              {ranAt && (
                <div style={{ fontSize: 10.5, color: 'var(--ink4)', marginTop: 8 }}>
                  Last run {new Date(ranAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
          {!running && !error && !sorted && (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>No checks have run yet.</div>
          )}
        </div>
      )}

      {activeTab === 'logs' && (
        <div style={bodyStyleFor(bodyHeight)} data-testid="checks-dock-logs">
          {logs.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>No activity yet — checks, chat, and run events will appear here.</div>
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
    </div>
  );
}

const countDotStyle = (color: string) =>
  ({
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: 999,
    background: color,
    marginRight: 4,
  }) as const;

const metaLineStyle = {
  fontFamily: 'var(--font-mono, var(--font-data))',
  fontSize: 10.5,
  letterSpacing: '0.02em',
  color: 'var(--ink4)',
  whiteSpace: 'nowrap',
} as const;

/**
 * ChecksBar — the always-mounted 36px collapsed strip: Checks/Logs tabs,
 * a mono "N NODES · M EDGES · last run" meta line, pass/fail/skip counts,
 * and the summary pill that doubles as the expand/collapse toggle.
 */
export function ChecksBar({
  running,
  error,
  results,
  ranAt,
  stale,
  nodeCount,
  edgeCount,
  expanded,
  onToggleExpanded,
  activeTab,
  onTabChange,
}: {
  running: boolean;
  error: string | null;
  results: CheckResult[] | null;
  ranAt: string | null;
  stale: boolean;
  nodeCount: number;
  edgeCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  activeTab: 'checks' | 'logs';
  onTabChange: (tab: 'checks' | 'logs') => void;
}) {
  const passCount = results?.filter((r) => r.status === 'pass').length ?? 0;
  const failCount = results?.filter((r) => r.status === 'fail').length ?? 0;
  const skipCount = results?.filter((r) => r.status === 'skip').length ?? 0;

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
  } else if (failCount > 0) {
    pillLabel = `${failCount} failing`;
    pillTone = 'bad';
  } else {
    pillLabel = 'All checks passed';
    pillTone = 'ok';
  }
  const pillStyle = PILL_TONE_STYLES[pillTone];
  const metaLine = `${nodeCount} NODE${nodeCount === 1 ? '' : 'S'} \u00B7 ${edgeCount} EDGE${edgeCount === 1 ? '' : 'S'} \u00B7 ${ranAt ? new Date(ranAt).toLocaleString().toUpperCase() : 'NOT RUN YET'}`;

  return (
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

      <span style={metaLineStyle}>{metaLine}</span>

      {results && (
        <span style={{ ...metaLineStyle, marginLeft: 12 }}>
          <span style={countDotStyle('var(--ok)')} />
          {passCount}
          <span style={{ marginLeft: 8, ...countDotStyle('var(--bad)') }} />
          {failCount}
          <span style={{ marginLeft: 8, ...countDotStyle('var(--ink4)') }} />
          {skipCount}
        </span>
      )}

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
          flex: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {pillLabel} {expanded ? '\u2303' : '\u2304'}
      </button>
    </div>
  );
}

export default function ChecksDock({
  running,
  error,
  results,
  ranAt,
  stale,
  nodeCount,
  edgeCount,
  expanded,
  onToggleExpanded,
  onSelectNode,
  activeTab,
  onTabChange,
  logs,
  onHeightChange,
}: {
  running: boolean;
  error: string | null;
  results: CheckResult[] | null;
  ranAt: string | null;
  /** True when latestCheckRun.graphVersion no longer matches the live graph version. */
  stale: boolean;
  /** Live graph node/edge counts, for ChecksBar's "N NODES · M EDGES" meta line. */
  nodeCount: number;
  edgeCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelectNode: (nodeId: string) => void;
  activeTab: 'checks' | 'logs';
  onTabChange: (tab: 'checks' | 'logs') => void;
  logs: ActivityItem[];
  /** Reports the dock's live rendered height (collapsed 36px, or 36 + the resizable body height when expanded) so FlowCanvas.tsx can keep the viewport toolbar clear of it — see styles.ts's viewportToolbarStyle. */
  onHeightChange?: (height: number) => void;
}) {
  const [bodyHeight, setBodyHeight] = useState(DOCK_BODY_DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number; currentHeight: number } | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const onToggleExpandedRef = useRef(onToggleExpanded);
  useEffect(() => {
    onToggleExpandedRef.current = onToggleExpanded;
  }, [onToggleExpanded]);

  useEffect(() => {
    const el = dockRef.current;
    if (!el || !onHeightChange) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) onHeightChange(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeightChange]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // Below MIN, let the body keep shrinking (down to a visual floor)
      // rather than clamping, so the drag itself previews the collapse.
      const next = Math.min(DOCK_BODY_MAX_HEIGHT, Math.max(DOCK_BODY_DRAG_FLOOR, drag.startHeight + (drag.startY - e.clientY)));
      drag.currentHeight = next;
      setBodyHeight(next);
    }
    function onUp() {
      const drag = dragRef.current;
      if (drag) {
        if (drag.currentHeight < DOCK_BODY_COLLAPSE_THRESHOLD) {
          // Snap collapsed and reset the body height so the next expand
          // (via a tab/pill click) opens back at a usable size.
          onToggleExpandedRef.current();
          setBodyHeight(DOCK_BODY_DEFAULT_HEIGHT);
        } else if (drag.currentHeight < DOCK_BODY_MIN_HEIGHT) {
          setBodyHeight(DOCK_BODY_MIN_HEIGHT);
        }
        dragRef.current = null;
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  function handleDragPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: bodyHeight, currentHeight: bodyHeight };
    setDragging(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div ref={dockRef} style={dockStyle} data-testid="checks-dock">
      {expanded && (
        <ChecksDrawer
          running={running}
          error={error}
          results={results}
          ranAt={ranAt}
          activeTab={activeTab}
          logs={logs}
          onSelectNode={onSelectNode}
          bodyHeight={bodyHeight}
          dragging={dragging}
          onDragPointerDown={handleDragPointerDown}
        />
      )}

      <ChecksBar
        running={running}
        error={error}
        results={results}
        ranAt={ranAt}
        stale={stale}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        activeTab={activeTab}
        onTabChange={onTabChange}
      />
    </div>
  );
}

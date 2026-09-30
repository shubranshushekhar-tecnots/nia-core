'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  navWordmarkStyle,
  nxBreadcrumbSepStyle,
  nxDropdownItemStyle,
  nxDropdownStyle,
  nxOrgSwitcherBtnStyle,
  nxPageCrumbCurrentStyle,
  nxPageCrumbLinkStyle,
  nxTopBarCellStyle,
  nxTopBarLogoCellStyle,
  nxTopBarSearchCellStyle,
  nxTopBarStyle,
  topBarKbdStyle,
  topBarSearchBtnFillStyle,
  topBarSearchLabelStyle,
} from '@/components/app/styles';
import { useAppShellStore } from '@/components/app/store';
import CommandPalette from '@/components/app/CommandPalette';
import Logo from '@/components/Logo';
import type { WorkflowStatus } from '@/lib/dashboard/types';
import {
  headerCopilotCellStyle,
  headerDraftChipStyle,
  headerRenameBtnStyle,
  headerRunCellStyle,
  headerRunChecksCellStyle,
  headerTabCellStyle,
} from './styles';
import { EditIcon, NxSearchIcon } from './navIcons';

// Wordmark hides below this cell width so "NIA CORE" never clips against
// the logo cell's right border while the sidebar (which this cell's width
// mirrors) is being dragged narrower — same threshold TopBar.tsx uses for
// its own logo cell.
const LOGO_CELL_WORDMARK_MIN_WIDTH = 120;

/**
 * 64px cell-based header for the workflow canvas — rebuilt to match
 * TopBar.tsx's shell exactly (same nxTopBarStyle row, same bordered-cell
 * primitives) instead of the old 52px flex-row-with-gaps layout, so the
 * canvas route's header no longer visually jumps against the rest of the
 * app shell. Every handler/prop below is unchanged from the previous
 * version — this is a pure JSX/styles rewrite.
 */
export default function CanvasHeader({
  orgName,
  projectName,
  projectHref,
  workflowName,
  workflowStatus,
  saveState,
  onReloadAfterConflict,
  checksRunning,
  onRunChecks,
  runEnabled,
  runInFlight,
  runTooltip,
  onRun,
  copilotOpen,
  onToggleCopilot,
  readOnly,
}: {
  orgName: string | null;
  projectName: string;
  projectHref: string;
  workflowName: string;
  workflowStatus: WorkflowStatus;
  saveState: 'idle' | 'saving' | 'saved' | 'conflict';
  onReloadAfterConflict: () => void;
  checksRunning: boolean;
  onRunChecks: () => void;
  runEnabled: boolean;
  runInFlight: boolean;
  runTooltip: string;
  onRun: () => void;
  copilotOpen: boolean;
  onToggleCopilot: () => void;
  readOnly: boolean;
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const railW = useAppShellStore((s) => s.railW);
  const showWordmark = railW >= LOGO_CELL_WORDMARK_MIN_WIDTH;

  // ⌘K/Ctrl+K focuses the search box (not the canvas's own shortcuts —
  // FlowCanvas.tsx has no ⌘K handling to conflict with).
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchBtnRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Escape blurs the search box without deselecting the canvas's active
  // node — FlowCanvas.tsx has its own global Escape listener that deselects
  // unless focus is inside `[data-node-config-panel]`; stopPropagation here
  // keeps that listener from firing while the search box has focus.
  function handleSearchKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.currentTarget.blur();
    }
  }

  return (
    <header style={nxTopBarStyle}>
      <div className="nx-wipe" style={nxTopBarLogoCellStyle(railW)}>
        <Logo size={40} showWordmark={false} />
        {showWordmark && <span style={navWordmarkStyle}>Nia Core</span>}
      </div>

      <div className="nx-wipe" style={{ ...nxTopBarCellStyle(), position: 'relative' }}>
        <button type="button" style={nxOrgSwitcherBtnStyle} onClick={() => setOrgMenuOpen((v) => !v)}>
          <span>{orgName ?? 'Personal workspace'}</span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--nx-ink-2)', lineHeight: 1 }}>{'\u25BE'}</span>
        </button>
        {orgMenuOpen && (
          <div style={nxDropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            <div style={{ ...nxDropdownItemStyle, fontWeight: 600, cursor: 'default' }}>
              {orgName ?? 'Personal workspace'}
            </div>
          </div>
        )}
      </div>

      <div className="nx-wipe" style={nxTopBarCellStyle()}>
        <span style={nxBreadcrumbSepStyle}>/</span>
        <a href="/app/projects" style={nxPageCrumbLinkStyle}>
          Projects
        </a>
        <span style={nxBreadcrumbSepStyle}>/</span>
        <a href={projectHref} style={nxPageCrumbLinkStyle}>
          {projectName}
        </a>
        <span style={nxBreadcrumbSepStyle}>/</span>
        <span style={nxPageCrumbCurrentStyle}>{workflowName}</span>
        {/* Always disabled — no PATCH /workflows/:id (rename) endpoint exists
            yet. Signals where renaming will live without faking that it works. */}
        <button type="button" disabled style={headerRenameBtnStyle} title="Renaming isn't available yet" aria-label="Rename workflow">
          <EditIcon size={13} />
        </button>
        {workflowStatus === 'draft' && <span style={headerDraftChipStyle}>Draft</span>}
        {readOnly && (
          <span style={{ fontSize: 12, color: 'var(--nx-ink-3)', border: '1px dashed var(--nx-line)', borderRadius: 'var(--nx-radius)', padding: '3px 8px' }}>
            View only
          </span>
        )}
        {saveState !== 'conflict' && saveState !== 'idle' && (
          <>
            <span style={nxBreadcrumbSepStyle}>·</span>
            <span style={{ fontSize: 12, color: 'var(--nx-ink-3)' }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
          </>
        )}
        {saveState === 'conflict' && (
          <button
            type="button"
            onClick={onReloadAfterConflict}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--nx-danger-text)',
              background: 'var(--nx-danger-tint)',
              border: '1px solid var(--nx-danger)',
              borderRadius: 'var(--nx-radius)',
              padding: '5px 10px',
              cursor: 'pointer',
            }}
          >
            Saved elsewhere — reload
          </button>
        )}
      </div>

      {/* Only "Editor" is wired — Runs/Schedule have no routes yet, so they
          render disabled with a "Coming soon" tooltip rather than dead links.
          `display: contents` keeps this a semantic tablist wrapper without
          inserting an extra flex box between these cells and the header row. */}
      <div role="tablist" aria-label="Workflow view" style={{ display: 'contents' }}>
        <button type="button" role="tab" aria-selected className="nx-wipe nx-active-cell" style={headerTabCellStyle}>
          Editor
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className="nx-wipe nx-row-disabled" style={headerTabCellStyle} title="Coming soon">
          Runs
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className="nx-wipe nx-row-disabled" style={headerTabCellStyle} title="Coming soon">
          Schedule
        </button>
      </div>

      <div style={{ marginLeft: 'auto' }} />

      <div className="nx-wipe" style={nxTopBarSearchCellStyle}>
        <button
          ref={searchBtnRef}
          type="button"
          style={topBarSearchBtnFillStyle}
          onClick={() => setPaletteOpen(true)}
          onKeyDown={handleSearchKeyDown}
        >
          <NxSearchIcon size={15} />
          <span style={topBarSearchLabelStyle}>Search or run</span>
          <span style={topBarKbdStyle}>{'\u2318K'}</span>
        </button>
      </div>

      <button
        type="button"
        className={copilotOpen ? undefined : 'nx-wipe'}
        style={headerCopilotCellStyle(copilotOpen)}
        onClick={onToggleCopilot}
        aria-pressed={copilotOpen}
        title={copilotOpen ? 'Hide Nia AI' : 'Show Nia AI'}
      >
        <Logo size={16} showWordmark={false} />
      </button>

      {!readOnly && (
        <button
          type="button"
          onClick={onRunChecks}
          disabled={checksRunning}
          className={checksRunning ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
          style={headerRunChecksCellStyle}
        >
          {checksRunning ? 'Running…' : 'Run checks'}
        </button>
      )}

      {runEnabled ? (
        <button
          type="button"
          onClick={onRun}
          title={runTooltip}
          className="nx-wipe"
          style={{ ...headerRunCellStyle(true, runInFlight), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
        >
          Run
        </button>
      ) : (
        <button type="button" disabled title={runTooltip} style={headerRunCellStyle(false, runInFlight)}>
          {runInFlight ? 'Running…' : 'Run'}
        </button>
      )}

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </header>
  );
}

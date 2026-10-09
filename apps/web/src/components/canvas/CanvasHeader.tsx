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
  nxTopBarStyle,
  topBarKbdStyle,
  topBarSearchBtnFillStyle,
} from '@/components/app/styles';
import { useAppShellStore } from '@/components/app/store';
import CommandPalette from '@/components/app/CommandPalette';
import Logo from '@/components/Logo';
import type { WorkflowStatus } from '@/lib/dashboard/types';
import {
  HEADER_CRUMB_EARLY_CLASS,
  HEADER_SEARCH_CELL_CLASS,
  HEADER_SEARCH_LABEL_CLASS,
  headerBreadcrumbCellStyle,
  headerCopilotCellStyle,
  headerCrumbEarlyGroupStyle,
  headerCrumbTextStyle,
  headerDraftChipStyle,
  headerOrgNameStyle,
  headerOrgSwitcherCellStyle,
  headerRenameBtnStyle,
  headerRunCellStyle,
  headerRunChecksCellStyle,
  headerSearchCellStyle,
  headerTabCellStyle,
} from './styles';
import { EditIcon, NxSearchIcon, RunArrowIcon } from './navIcons';

// Wordmark hides below this cell width so "NIA CORE" never clips against
// the logo cell's right border while the sidebar (which this cell's width
// mirrors) is being dragged narrower — same threshold TopBar.tsx uses for
// its own logo cell.
const LOGO_CELL_WORDMARK_MIN_WIDTH = 120;

/**
 * Polish pass — agent-delivered workflows (B.7) fail "Run checks" on two
 * checks that aren't real problems here: a write grant (agent-delivered
 * destinations don't use write grants) and "connection is missing agent
 * configuration" (that connection is configured by the agent itself, not
 * through this UI). Rather than special-case those two check ids, this
 * job is checked automatically when published and again by the agent on
 * every run — so manual "Run checks" is disabled outright for these
 * workflows, with this tooltip explaining why.
 */
export const AGENT_RUN_CHECKS_DISABLED_TITLE =
  "Not available for agent-delivered workflows — this job is checked when it's published, and again by the agent before each run.";

/**
 * 64px cell-based header for the workflow canvas — rebuilt to match
 * TopBar.tsx's shell exactly (same nxTopBarStyle row, same bordered-cell
 * primitives) instead of the old 52px flex-row-with-gaps layout, so the
 * canvas route's header no longer visually jumps against the rest of the
 * app shell. Every handler/prop below is unchanged from the previous
 * version — this is a pure JSX/styles rewrite.
 *
 * UI-10 (top bar layout fix): every cell is single-line (white-space:
 * nowrap + ellipsis on overflow, full value in `title`) and flex:'none'
 * (never shrinks) EXCEPT the breadcrumb cell, which is flex:1/minWidth:0
 * and absorbs all the squeeze. Two width breakpoints (<1440px collapses
 * search to an icon; <1200px hides the "Projects / <project> /" lead-in,
 * keeping only the workflow name) keep the Run cell visible at all times
 * without it ever needing to shrink itself.
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
  agentDelivered,
  runEnabled,
  runInFlight,
  runTooltip,
  onRun,
  agentPublish,
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
  /** True for agent-delivered workflows (B.7) — disables Run checks, see AGENT_RUN_CHECKS_DISABLED_TITLE above. */
  agentDelivered: boolean;
  runEnabled: boolean;
  runInFlight: boolean;
  runTooltip: string;
  onRun: () => void;
  /**
   * Slice R4 (B.7, item 6) — "Publish, in place of Run for these
   * workflows". Set (non-null) only when FlowCanvas.tsx's
   * isAgentDeliveredWorkflow() is true; everything else about the header
   * (checks button, tabs, etc.) stays exactly as it is for every other
   * workflow.
   */
  agentPublish?: {
    state: 'unpublished' | 'waiting' | 'applied' | 'rejected';
    wantedVersion: number;
    appliedVersion: number;
    rejectionReason: string | null;
    publishEnabled: boolean;
    publishTooltip: string;
    publishing: boolean;
    unpublishing: boolean;
    onPublish: () => void;
    onUnpublish: () => void;
  } | null;
  copilotOpen: boolean;
  onToggleCopilot: () => void;
  readOnly: boolean;
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const railW = useAppShellStore((s) => s.railW);
  const showWordmark = railW >= LOGO_CELL_WORDMARK_MIN_WIDTH;
  const orgLabel = orgName ?? 'Personal workspace';

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

      <div
        className="nx-wipe"
        style={{ ...nxTopBarCellStyle(), ...headerOrgSwitcherCellStyle, position: 'relative' }}
      >
        <button
          type="button"
          style={{ ...nxOrgSwitcherBtnStyle, fontSize: 14 }}
          onClick={() => setOrgMenuOpen((v) => !v)}
        >
          <span style={headerOrgNameStyle} title={orgLabel}>
            {orgLabel}
          </span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--nx-ink-2)', lineHeight: 1, flex: 'none' }}>
            {'\u25BE'}
          </span>
        </button>
        {orgMenuOpen && (
          <div style={nxDropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            <div style={{ ...nxDropdownItemStyle, fontWeight: 600, cursor: 'default' }}>{orgLabel}</div>
          </div>
        )}
      </div>

      <div
        className="nx-wipe"
        style={headerBreadcrumbCellStyle}
        title={`Projects / ${projectName} / ${workflowName}`}
      >
        <span className={HEADER_CRUMB_EARLY_CLASS} style={headerCrumbEarlyGroupStyle}>
          <span style={nxBreadcrumbSepStyle}>/</span>
          <a href="/app/projects" style={nxPageCrumbLinkStyle}>
            Projects
          </a>
          <span style={nxBreadcrumbSepStyle}>/</span>
          <a href={projectHref} style={{ ...nxPageCrumbLinkStyle, ...headerCrumbTextStyle(160) }} title={projectName}>
            {projectName}
          </a>
          <span style={nxBreadcrumbSepStyle}>/</span>
        </span>
        <span style={{ ...nxPageCrumbCurrentStyle, ...headerCrumbTextStyle(280) }} title={workflowName}>
          {workflowName}
        </span>
        {/* Always disabled — no PATCH /workflows/:id (rename) endpoint exists
            yet. Signals where renaming will live without faking that it works. */}
        <button type="button" disabled style={headerRenameBtnStyle} title="Renaming isn't available yet" aria-label="Rename workflow">
          <EditIcon size={14} />
        </button>
        {workflowStatus === 'draft' && <span style={headerDraftChipStyle}>Draft</span>}
        {readOnly && (
          <span
            style={{
              flex: 'none',
              whiteSpace: 'nowrap',
              fontSize: 12,
              color: 'var(--nx-ink-3)',
              border: '1px dashed var(--nx-line)',
              borderRadius: 'var(--nx-radius)',
              padding: '3px 8px',
            }}
          >
            View only
          </span>
        )}
        {saveState !== 'conflict' && saveState !== 'idle' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', whiteSpace: 'nowrap' }}>
            <span style={nxBreadcrumbSepStyle}>·</span>
            <span style={{ fontSize: 12, color: 'var(--nx-ink-3)' }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
          </span>
        )}
        {saveState === 'conflict' && (
          <button
            type="button"
            onClick={onReloadAfterConflict}
            style={{
              flex: 'none',
              whiteSpace: 'nowrap',
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

      <div className={`nx-wipe ${HEADER_SEARCH_CELL_CLASS}`} style={headerSearchCellStyle}>
        <button
          ref={searchBtnRef}
          type="button"
          style={{ ...topBarSearchBtnFillStyle, justifyContent: 'center' }}
          onClick={() => setPaletteOpen(true)}
          onKeyDown={handleSearchKeyDown}
          title="Search or run (\u2318K)"
        >
          <NxSearchIcon size={15} />
          <span className={HEADER_SEARCH_LABEL_CLASS} style={{ ...topBarKbdStyle, marginLeft: 0 }}>
            {'\u2318K'}
          </span>
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
        <Logo size={18} showWordmark={false} src="/splash-icon.png" />
      </button>

      {!readOnly && (
        <button
          type="button"
          onClick={onRunChecks}
          disabled={checksRunning || agentDelivered}
          title={agentDelivered ? AGENT_RUN_CHECKS_DISABLED_TITLE : undefined}
          className={checksRunning || agentDelivered ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
          style={headerRunChecksCellStyle}
        >
          {checksRunning ? 'Running…' : 'Run checks'}
        </button>
      )}

      {agentPublish ? (
        <>
          <span
            title={
              agentPublish.state === 'rejected'
                ? agentPublish.rejectionReason ?? 'Rejected by the agent.'
                : agentPublish.state === 'applied'
                  ? `Applied — version ${agentPublish.appliedVersion}`
                  : agentPublish.state === 'waiting'
                    ? `Waiting for the agent — version ${agentPublish.wantedVersion}`
                    : 'Not published'
            }
            style={{
              flex: 'none',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: 'var(--nx-radius)',
              border: '1px solid var(--nx-line)',
              color:
                agentPublish.state === 'rejected'
                  ? 'var(--nx-danger-text)'
                  : agentPublish.state === 'applied'
                    ? 'var(--nx-success-text, var(--nx-ink))'
                    : 'var(--nx-ink-3)',
              background:
                agentPublish.state === 'rejected' ? 'var(--nx-danger-tint)' : 'transparent',
            }}
          >
            {agentPublish.state === 'unpublished' && 'Not published'}
            {agentPublish.state === 'waiting' && 'Waiting for agent…'}
            {agentPublish.state === 'applied' && `Applied · v${agentPublish.appliedVersion}`}
            {agentPublish.state === 'rejected' && 'Rejected'}
          </span>
          {agentPublish.state === 'rejected' && agentPublish.rejectionReason && (
            <span
              style={{
                flex: 'none',
                fontSize: 11.5,
                color: 'var(--nx-danger-text)',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={agentPublish.rejectionReason}
            >
              {agentPublish.rejectionReason}
            </span>
          )}
          {agentPublish.state !== 'unpublished' && !readOnly && (
            <button
              type="button"
              onClick={agentPublish.onUnpublish}
              disabled={agentPublish.unpublishing}
              className={agentPublish.unpublishing ? 'nx-wipe nx-row-disabled' : 'nx-wipe'}
              style={headerRunChecksCellStyle}
            >
              {agentPublish.unpublishing ? 'Unpublishing…' : 'Unpublish'}
            </button>
          )}
          {agentPublish.publishEnabled ? (
            <button
              type="button"
              onClick={agentPublish.onPublish}
              title={agentPublish.publishTooltip}
              className="nx-wipe"
              style={{ ...headerRunCellStyle(true, agentPublish.publishing), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Publish</span>
              <RunArrowIcon size={11} />
            </button>
          ) : (
            <button type="button" disabled title={agentPublish.publishTooltip} style={headerRunCellStyle(false, agentPublish.publishing)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{agentPublish.publishing ? 'Publishing…' : 'Publish'}</span>
              <RunArrowIcon size={11} />
            </button>
          )}
        </>
      ) : runEnabled ? (
        <button
          type="button"
          onClick={onRun}
          title={runTooltip}
          className="nx-wipe"
          style={{ ...headerRunCellStyle(true, runInFlight), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Run</span>
          <RunArrowIcon size={11} />
        </button>
      ) : (
        <button type="button" disabled title={runTooltip} style={headerRunCellStyle(false, runInFlight)}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{runInFlight ? 'Running…' : 'Run'}</span>
          <RunArrowIcon size={11} />
        </button>
      )}

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}

      <style>{`
        @media (max-width: 1439px) {
          .${HEADER_SEARCH_CELL_CLASS} { width: 64px !important; padding: 0 !important; }
          .${HEADER_SEARCH_LABEL_CLASS} { display: none; }
        }
        @media (max-width: 1199px) {
          .${HEADER_CRUMB_EARLY_CLASS} { display: none; }
        }
      `}</style>
    </header>
  );
}

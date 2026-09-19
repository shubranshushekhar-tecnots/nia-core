'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { breadcrumbSepStyle, dropdownItemStyle, dropdownStyle, orgSwitcherBtnStyle } from '@/components/app/styles';
import CommandPalette from '@/components/app/CommandPalette';
import Logo from '@/components/Logo';
import {
  headerCopilotToggleBtnStyle,
  headerRunBtnStyle,
  headerRunChecksBtnStyle,
  headerSearchInputStyle,
  headerSearchKbdStyle,
  headerSearchLabelStyle,
  topBarStyle,
} from './styles';

/**
 * 48px merged header for the workflow canvas (canvasredesign.html) —
 * relocates FlowCanvas.tsx's previous inline `<header>` JSX verbatim: same
 * handlers/props, no new logic. Rendered inside FlowCanvas.tsx (not
 * page-level, unlike CanvasIconRail — see FlowCanvas.tsx's own comment).
 */
export default function CanvasHeader({
  orgName,
  projectName,
  projectHref,
  workflowName,
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
}: {
  orgName: string | null;
  projectName: string;
  projectHref: string;
  workflowName: string;
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
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement>(null);

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
    <header style={topBarStyle}>
      <div style={{ position: 'relative' }}>
        <button type="button" style={orgSwitcherBtnStyle} onClick={() => setOrgMenuOpen((v) => !v)}>
          <span>{orgName ?? 'Personal workspace'}</span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--ink4)', lineHeight: 1 }}>{'\u25BE'}</span>
        </button>
        {orgMenuOpen && (
          <div style={dropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            <div style={{ ...dropdownItemStyle, fontWeight: 600, cursor: 'default' }}>
              {orgName ?? 'Personal workspace'}
            </div>
          </div>
        )}
      </div>

      <span style={breadcrumbSepStyle}>/</span>
      <a href={projectHref} style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', textDecoration: 'none' }}>
        {projectName}
      </a>
      <span style={breadcrumbSepStyle}>/</span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{workflowName}</span>
      {saveState !== 'conflict' && saveState !== 'idle' && (
        <>
          <span style={breadcrumbSepStyle}>·</span>
          <span style={{ fontSize: 12, color: 'var(--ink4)' }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
        </>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {saveState === 'conflict' && (
          <button
            type="button"
            onClick={onReloadAfterConflict}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--bad)',
              background: 'var(--warn-bg)',
              border: '1px solid var(--warn-bd)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
            }}
          >
            Saved elsewhere — reload
          </button>
        )}

        <button
          ref={searchBtnRef}
          type="button"
          style={headerSearchInputStyle}
          onClick={() => setPaletteOpen(true)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search or run"
        >
          <span aria-hidden>{'\u2315'}</span>
          <span style={headerSearchLabelStyle}>Search or run</span>
          <span style={headerSearchKbdStyle}>{'\u2318K'}</span>
        </button>

        <button
          type="button"
          style={headerCopilotToggleBtnStyle(copilotOpen)}
          onClick={onToggleCopilot}
          aria-pressed={copilotOpen}
          title={copilotOpen ? 'Hide Nia AI' : 'Show Nia AI'}
        >
          <Logo size={16} showWordmark={false} />
        </button>

        <button type="button" onClick={onRunChecks} disabled={checksRunning} style={headerRunChecksBtnStyle(checksRunning)}>
          {checksRunning ? 'Running…' : 'Run checks'}
        </button>

        {runEnabled ? (
          <button type="button" onClick={onRun} title={runTooltip} style={headerRunBtnStyle(true, runInFlight)}>
            Run
          </button>
        ) : (
          <button type="button" disabled title={runTooltip} style={headerRunBtnStyle(false, runInFlight)}>
            {runInFlight ? 'Running…' : 'Run'}
          </button>
        )}
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </header>
  );
}

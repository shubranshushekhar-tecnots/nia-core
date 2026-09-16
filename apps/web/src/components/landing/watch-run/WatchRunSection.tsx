'use client';

import { useCallback, useRef, useState } from 'react';
import Reveal from '../Reveal';
import { demoFrameStyle } from '../styles';
import Canvas from './Canvas';
import Dock from './Dock';
import Inspector from './Inspector';
import { useRunClock } from './useRunClock';
import {
  CHECKS_PASS,
  LOOP_DURATION,
  NODES,
  getAutoDockTab,
  getAutoFollowedNode,
  getChecksCompleted,
  getElapsedLabel,
  getNodeProgress,
  getNodeStatus,
  getPillState,
  getRowsCount,
  getRunButtonState,
  getVisibleLogCount,
} from './config';
import type { NodeKind, NodeStatus } from './config';

export default function WatchRunSection() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState(0);
  const [pinnedId, setPinnedId] = useState<NodeKind | null>(null);
  const [dockTab, setDockTab] = useState<'checks' | 'logs'>('checks');
  const [userPickedTab, setUserPickedTab] = useState(false);
  const prevTRef = useRef(0);

  const handleTick = useCallback((nt: number) => {
    if (nt < prevTRef.current - 0.5) {
      // loop wrapped back to the start — clear manual overrides
      setUserPickedTab(false);
      setPinnedId(null);
    }
    prevTRef.current = nt;
    setT(nt);
  }, []);

  const clock = useRunClock(rootRef, handleTick);

  const statuses = {} as Record<NodeKind, NodeStatus>;
  const progress = {} as Record<NodeKind, number>;
  NODES.forEach((n) => {
    statuses[n.id] = getNodeStatus(n.id, t);
    progress[n.id] = getNodeProgress(n.id, t);
  });

  const rowsRead = getRowsCount('read', t);
  const rowsPushed = getRowsCount('push', t);
  const checksCompleted = getChecksCompleted(t);
  const visibleLogCount = getVisibleLogCount(t);
  const autoTab = getAutoDockTab(t);
  const activeTab = userPickedTab ? dockTab : autoTab;
  const autoFollowed = getAutoFollowedNode(t);
  const followedId = pinnedId ?? autoFollowed;
  const elapsedLabel = getElapsedLabel(t);
  const runBtn = getRunButtonState(t);
  const pill = getPillState(t);
  const running = pill === 'running';

  const handleTabChange = (tab: 'checks' | 'logs') => {
    setUserPickedTab(true);
    setDockTab(tab);
  };
  const handleSelectNode = (id: NodeKind) => setPinnedId(id);
  const handleFollowRun = () => setPinnedId(null);
  const handleRunClick = () => {
    if (!runBtn.disabled) clock.runNow(CHECKS_PASS);
  };

  const pillLabel = pill === 'checking' ? 'Checking…' : pill === 'running' ? `Running · ${elapsedLabel}` : 'Run succeeded';

  return (
    <div ref={rootRef} id="watch-run-root">
      <Reveal className="wr-header">
        <div className="wr-header-copy">
          <h2 className="wr-h2">Watch a pipeline run itself</h2>
          <p className="wr-lede">
            A real replay of a nightly run — checks, live counters, logs, and a branch that skips itself when there&apos;s nothing new.
          </p>
        </div>
        <div className="wr-header-controls">
          <button type="button" className="wr-icon-btn" aria-pressed={!clock.playing} onClick={clock.togglePlay}>
            {clock.playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="wr-icon-btn" onClick={clock.replay}>
            Replay
          </button>
        </div>
      </Reveal>

      <Reveal style={demoFrameStyle}>
        <div className="wr-titlebar">
          <span className="wr-dot" style={{ background: '#F87171' }} />
          <span className="wr-dot" style={{ background: '#FBBF24' }} />
          <span className="wr-dot" style={{ background: '#34D399' }} />
          <span className="wr-titlebar-path">nia.app / sales-analysis</span>
          <span className={`wr-status-pill wr-status-${pill}`}>{pillLabel}</span>
          <button type="button" className="wr-run-btn" aria-disabled={runBtn.disabled} onClick={handleRunClick}>
            {runBtn.label}
          </button>
        </div>
        <span className="wr-titlebar-progress" style={{ width: `${(t / LOOP_DURATION) * 100}%` }} aria-hidden="true" />

        <Canvas
          statuses={statuses}
          progress={progress}
          rowsRead={rowsRead}
          rowsPushed={rowsPushed}
          followedId={followedId}
          pinnedId={pinnedId}
          onSelect={handleSelectNode}
        />

        <div className="wr-lower">
          <Dock
            activeTab={activeTab}
            onTabChange={handleTabChange}
            checksCompleted={checksCompleted}
            visibleLogCount={visibleLogCount}
            running={running}
          />
          <Inspector nodeId={followedId} isPinned={pinnedId !== null} onFollowRun={handleFollowRun} />
        </div>
      </Reveal>

      <style>{`
        #watch-run-root { display: flex; flex-direction: column; gap: 0; }

        .wr-header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
        .wr-header-copy { display: flex; flex-direction: column; gap: 8px; max-width: 560px; }
        .wr-h2 { margin: 0; font-size: clamp(28px,4vw,38px); font-weight: 700; letter-spacing: -.03em; }
        .wr-lede { margin: 0; font-size: 15px; line-height: 1.6; color: var(--secondary); }
        .wr-header-controls { display: flex; gap: 8px; }
        .wr-icon-btn { display: inline-flex; align-items: center; height: 36px; padding: 0 14px; border-radius: 9px; font-size: 13px; font-weight: 600; color: var(--secondary); background: var(--surface); border: 1px solid var(--line); cursor: pointer; }
        .wr-icon-btn:hover { border-color: var(--line-strong); }
        .wr-icon-btn[aria-pressed="true"] { color: var(--primary); border-color: var(--primary); }

        .wr-titlebar { display: flex; align-items: center; gap: 7px; padding: 11px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
        .wr-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
        .wr-titlebar-path { margin-left: 10px; margin-right: auto; font-size: 11.5px; color: var(--muted); }
        .wr-status-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap; }
        .wr-status-checking { background: var(--subtle); color: var(--muted); }
        .wr-status-running { background: var(--primary-soft); color: var(--primary); }
        .wr-status-succeeded { background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success-deep); }
        .wr-run-btn { display: inline-flex; align-items: center; height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: #fff; background: var(--primary); border: none; cursor: pointer; }
        .wr-run-btn[aria-disabled="true"] { background: var(--line-strong); color: var(--surface); cursor: default; }
        .wr-titlebar-progress { display: block; height: 2px; background: var(--primary); transition: width .12s linear; }

        .wr-canvas { position: relative; padding: 28px 22px 34px; background-image: radial-gradient(circle,#E7ECF3 1px,transparent 1px); background-size: 20px 20px; }
        .wr-canvas-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
        .wr-canvas-grid {
          position: relative;
          display: grid;
          grid-template-columns: repeat(5, minmax(110px,1fr));
          grid-template-rows: auto auto;
          grid-template-areas: "schedule read transform condition push" ".        .    .         .         end";
          gap: 30px 16px;
          align-items: start;
        }
        @media (max-width: 1080px) {
          .wr-canvas-grid { grid-template-columns: 1fr; grid-template-areas: "schedule" "read" "transform" "condition" "push" "end"; gap: 16px; }
        }

        .wr-node { position: relative; text-align: left; overflow: hidden; box-sizing: border-box; padding: 14px 14px 12px; min-height: 104px; border-radius: 14px; background: linear-gradient(180deg,#FFFFFF,#FAFBFE); border: 1px solid var(--line); cursor: pointer; display: flex; flex-direction: column; gap: 6px; font: inherit; }
        .wr-node[data-muted="true"] { border-style: dashed; }
        .wr-node[data-followed="true"] { box-shadow: 0 0 0 2px color-mix(in srgb, var(--wr-tone) 35%, transparent); }
        .wr-node[data-pinned="true"] { border-color: var(--primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 30%, transparent); }
        .wr-node[data-status="running"] { border-color: var(--wr-tone); box-shadow: 0 1px 2px rgba(15,23,42,.05), 0 12px 26px -18px color-mix(in srgb, var(--wr-tone) 50%, transparent); }
        .wr-node[data-status="skipped"] { opacity: .55; }
        .wr-node-top { display: flex; align-items: center; gap: 8px; }
        .wr-node-chip { width: 26px; height: 26px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 8px; font-size: 10.5px; font-weight: 700; background: color-mix(in srgb, var(--wr-tone) 12%, transparent); color: var(--wr-tone); }
        .wr-node-type { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; color: var(--wr-tone); text-transform: uppercase; }
        .wr-node-name { font-size: 12.5px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wr-node-status { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .wr-node-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }
        .wr-node[data-status="running"] .wr-node-dot { background: var(--wr-tone); animation: wrPulse 1s ease-in-out infinite; }
        .wr-node[data-status="done"] .wr-node-dot { background: var(--success); }
        .wr-node-bar-track { height: 3px; border-radius: 2px; background: var(--subtle); overflow: hidden; }
        .wr-node-bar-fill { display: block; height: 100%; background: var(--wr-tone); }

        .wr-lower { display: flex; gap: 16px; padding: 16px 22px 22px; border-top: 1px solid var(--line); }
        @media (max-width: 1100px) { .wr-lower { flex-direction: column; } }

        .wr-dock, .wr-inspector { flex: 1 1 0; min-width: 0; box-sizing: border-box; padding: 14px 16px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); }
        .wr-tablist { display: flex; gap: 6px; margin-bottom: 10px; }
        .wr-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--secondary); background: transparent; border: 1px solid transparent; cursor: pointer; }
        .wr-tab[data-active="true"] { background: var(--subtle); color: var(--text); }
        .wr-tab-badge { font-size: 10.5px; color: var(--muted); }
        .wr-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--error); display: inline-block; animation: wrBlink 1s step-start infinite; }
        .wr-checks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
        .wr-check-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
        .wr-check-row[data-done="true"] { color: var(--text); }
        .wr-check-dot { width: 14px; height: 14px; border-radius: 50%; flex: none; border: 1.5px dashed var(--line-strong); }
        .wr-check-row[data-done="true"] .wr-check-dot { border-style: solid; border-color: var(--success); background: var(--success); }
        .wr-log { height: 150px; overflow-y: auto; font-family: var(--font-plex-mono, monospace); font-size: 11.5px; line-height: 1.7; color: var(--secondary); }
        .wr-log-meta { color: var(--muted); }
        .wr-caret { display: inline-block; width: 6px; height: 12px; background: var(--primary); animation: wrBlink 1s step-start infinite; vertical-align: text-bottom; }

        .wr-inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
        .wr-inspector-kicker { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; }
        .wr-inspector-title { margin: 2px 0 0; font-size: 15px; font-weight: 700; color: var(--text); }
        .wr-following-pill { flex: none; font-size: 10.5px; font-weight: 600; color: var(--muted); padding: 3px 9px; border-radius: 999px; background: var(--subtle); white-space: nowrap; }
        .wr-follow-btn { flex: none; font-size: 10.5px; font-weight: 600; color: var(--primary); padding: 3px 9px; border-radius: 999px; background: var(--primary-soft); border: none; cursor: pointer; white-space: nowrap; }
        .wr-inspector-desc { margin: 0 0 10px; font-size: 12.5px; line-height: 1.6; color: var(--secondary); }
        .wr-code-block { margin: 0 0 10px; padding: 10px 12px; border-radius: 9px; background: var(--text); color: #fff; font-family: var(--font-plex-mono, monospace); font-size: 11.5px; line-height: 1.7; overflow-x: auto; }
        .wr-bars { display: flex; align-items: flex-end; gap: 5px; height: 46px; margin-bottom: 10px; }
        .wr-bar { flex: 1; border-radius: 2px 2px 0 0; min-height: 3px; }
        .wr-ops-list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--secondary); }
        .wr-ops-list li { padding-left: 14px; position: relative; }
        .wr-ops-list li::before { content: ''; position: absolute; left: 0; top: 7px; width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); }
        .wr-result-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; }
        .wr-result-success { background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success-deep); }
        .wr-result-muted { background: var(--subtle); color: var(--muted); }

        @media (max-width: 860px) { .wr-header-controls { width: 100%; } }

        @media (max-width: 760px) {
          .wr-canvas { padding: 22px 16px 26px; }
          .wr-lower { padding: 14px 16px 18px; }
          .wr-titlebar-path { margin-right: 0; flex-basis: 100%; order: 1; }
          .wr-status-pill { order: 2; }
          .wr-run-btn { order: 3; margin-left: auto; }
        }

        @keyframes wrPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
        @keyframes wrBlink { 50% { opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
          .wr-node-dot, .wr-live-dot, .wr-caret { animation: none; }
          .wr-titlebar-progress, .wr-node-bar-fill { transition: none; }
        }
      `}</style>
    </div>
  );
}

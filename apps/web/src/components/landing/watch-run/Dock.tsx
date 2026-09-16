'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { CHECKS, LOG_ENTRIES, formatLogTime } from './config';

export default function Dock({
  activeTab,
  onTabChange,
  checksCompleted,
  visibleLogCount,
  running,
}: {
  activeTab: 'checks' | 'logs';
  onTabChange: (tab: 'checks' | 'logs') => void;
  checksCompleted: number;
  visibleLogCount: number;
  running: boolean;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleLogCount, activeTab]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onTabChange(activeTab === 'checks' ? 'logs' : 'checks');
    }
  };

  return (
    <div className="wr-dock">
      <div role="tablist" aria-label="Run details" className="wr-tablist" onKeyDown={onKeyDown}>
        <button
          type="button"
          role="tab"
          id="wr-tab-checks"
          aria-selected={activeTab === 'checks'}
          aria-controls="wr-panel-checks"
          className="wr-tab"
          data-active={activeTab === 'checks'}
          onClick={() => onTabChange('checks')}
        >
          Checks <span className="wr-tab-badge">{checksCompleted}/{CHECKS.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="wr-tab-logs"
          aria-selected={activeTab === 'logs'}
          aria-controls="wr-panel-logs"
          className="wr-tab"
          data-active={activeTab === 'logs'}
          onClick={() => onTabChange('logs')}
        >
          Logs {running && <span className="wr-live-dot" aria-hidden="true" />}
        </button>
      </div>

      {activeTab === 'checks' ? (
        <ul id="wr-panel-checks" role="tabpanel" aria-labelledby="wr-tab-checks" className="wr-checks-list">
          {CHECKS.map((c, i) => (
            <li key={c.id} className="wr-check-row" data-done={i < checksCompleted}>
              <span className="wr-check-dot" aria-hidden="true" />
              {c.label}
            </li>
          ))}
        </ul>
      ) : (
        <div id="wr-panel-logs" role="tabpanel" aria-labelledby="wr-tab-logs" className="wr-log" ref={logRef} aria-live="polite">
          {LOG_ENTRIES.slice(0, visibleLogCount).map((l, i) => (
            <div key={i} className="wr-log-line">
              <span className="wr-log-meta">{formatLogTime(l.t)}</span> {l.text}
            </div>
          ))}
          {running && <span className="wr-caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

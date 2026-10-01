import type { CSSProperties } from 'react';
import { AlertIcon } from './icons';

/**
 * Console dark/red/square theme — shared status-pill component. Replaces
 * the old `consolePillStyle(tone)` helper (a bare style object each call
 * site applied to a <span>text</span>) with an actual component: the
 * spec requires every status pill to render a square 6x6 dot (pulsing for
 * "running") plus the word, and "error" additionally needs an alert icon
 * — neither fits a plain style-object + raw text call site cleanly, so
 * this is the one genuinely forked/new component the console theme pass
 * introduces (see also icons.tsx).
 */

export type StatusTone = 'success' | 'running' | 'warning' | 'info' | 'error' | 'neutral';

const TONE_COLOR: Record<StatusTone, string> = {
  success: 'var(--c-success)',
  running: 'var(--c-warning)',
  warning: 'var(--c-warning)',
  info: 'var(--c-info)',
  error: 'var(--c-error)',
  neutral: 'var(--c-text-3)',
};

const TONE_BG: Record<StatusTone, string> = {
  success: 'var(--c-success-bg)',
  running: 'var(--c-warning-bg)',
  warning: 'var(--c-warning-bg)',
  info: 'var(--c-info-bg)',
  error: 'var(--c-error-bg)',
  neutral: 'var(--c-surface-2)',
};

const wrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 22,
  boxSizing: 'border-box',
  padding: '0 8px',
  borderRadius: 0,
  fontFamily: 'var(--c-font-sans)',
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

export default function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  const color = TONE_COLOR[tone];
  return (
    <span style={{ ...wrapStyle, color, background: TONE_BG[tone] }}>
      {tone === 'error' ? (
        <AlertIcon size={12} />
      ) : (
        <span
          className={tone === 'running' ? 'c-status-dot--running' : undefined}
          style={{ width: 6, height: 6, flex: 'none', background: color }}
        />
      )}
      {label}
    </span>
  );
}

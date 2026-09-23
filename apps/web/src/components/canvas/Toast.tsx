'use client';

import { useCallback, useRef, useState, type CSSProperties } from 'react';

/**
 * Minimal, canvas-scoped toast — not a global/app-wide system, since only
 * the node context menu needs one today (Test connection / Refresh
 * results). Top-right stack, auto-dismiss after ~4s.
 */

export type Toast = { id: string; kind: 'success' | 'error'; message: string };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = `t${++nextId.current}`;
      setToasts((prev) => [...prev, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

const stackStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 60,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
};

const toastStyle = (kind: Toast['kind']): CSSProperties => ({
  pointerEvents: 'auto',
  minWidth: 220,
  maxWidth: 360,
  background: 'var(--surface)',
  border: `1px solid ${kind === 'error' ? 'var(--bad)' : 'var(--panel-line)'}`,
  borderRadius: 10,
  boxShadow: 'var(--floating-panel-shadow)',
  padding: '10px 12px',
  fontSize: 12.5,
  color: kind === 'error' ? 'var(--bad)' : 'var(--ink)',
});

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div style={stackStyle}>
      {toasts.map((t) => (
        <div key={t.id} style={toastStyle(t.kind)} onClick={() => onDismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

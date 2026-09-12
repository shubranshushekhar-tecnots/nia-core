'use client';

import { useState } from 'react';
import type { CanvasNode } from '@/lib/dashboard/types';

// v1 config is generic key/value fields, not per-tool-typed forms (deferred —
// see plan's "Out of scope for this pass").
export default function NodeConfigPanel({
  node,
  onChange,
  onClose,
}: {
  node: CanvasNode;
  onChange: (config: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<[string, string][]>(Object.entries(node.config));
  const [newKey, setNewKey] = useState('');

  function commit(next: [string, string][]) {
    setEntries(next);
    onChange(Object.fromEntries(next));
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 56,
        bottom: 0,
        width: 300,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--line2)',
        padding: 16,
        overflowY: 'auto',
        zIndex: 30,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{node.handle}</span>
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 14, padding: 0 }}
        >
          {'\u2715'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 16 }}>
        {node.tool} {'\u00b7'} {node.kind}
      </div>

      <div
        style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink4)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}
      >
        Params
      </div>

      {entries.map(([key, value], i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            value={key}
            onChange={(e) => {
              const next = [...entries] as [string, string][];
              next[i] = [e.target.value, value];
              commit(next);
            }}
            style={{ width: '38%', height: 30, borderRadius: 6, border: '1px solid var(--line2)', padding: '0 8px', fontSize: 12.5, boxSizing: 'border-box' }}
          />
          <input
            value={value}
            onChange={(e) => {
              const next = [...entries] as [string, string][];
              next[i] = [key, e.target.value];
              commit(next);
            }}
            style={{ flex: 1, height: 30, borderRadius: 6, border: '1px solid var(--line2)', padding: '0 8px', fontSize: 12.5, boxSizing: 'border-box' }}
          />
          <button
            type="button"
            onClick={() => commit(entries.filter((_, idx) => idx !== i))}
            style={{ width: 26, border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer' }}
          >
            {'\u2715'}
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Field name"
          style={{ flex: 1, height: 30, borderRadius: 6, border: '1px solid var(--line2)', padding: '0 8px', fontSize: 12.5, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          onClick={() => {
            if (!newKey.trim()) return;
            commit([...entries, [newKey, '']]);
            setNewKey('');
          }}
          style={{ height: 30, padding: '0 10px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--surface2)', fontSize: 12.5, cursor: 'pointer' }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

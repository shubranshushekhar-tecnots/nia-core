'use client';

import { useState } from 'react';
import type { CanvasNode } from '@/lib/dashboard/types';

export type NodeCatalogEntry = {
  kind: CanvasNode['kind'];
  tool: string;
  label: string;
  group: string;
};

// Static catalog for v1 — grouped by the same categories as the design's
// builder library panel. Per-tool typed config forms are deferred; picking an
// entry just seeds `tool`/`handle` on the new node.
export const NODE_CATALOG: NodeCatalogEntry[] = [
  { kind: 'trigger', tool: 'schedule', label: 'Scheduled trigger', group: 'Triggers' },
  { kind: 'trigger', tool: 'webhook', label: 'Webhook trigger', group: 'Triggers' },
  { kind: 'source', tool: 'mysql', label: 'MySQL', group: 'Databases' },
  { kind: 'source', tool: 'postgres', label: 'Postgres', group: 'Databases' },
  { kind: 'source', tool: 'mongodb', label: 'MongoDB', group: 'Databases' },
  { kind: 'file', tool: 'csv', label: 'CSV file', group: 'Files' },
  { kind: 'file', tool: 'excel', label: 'Excel file', group: 'Files' },
  { kind: 'transform', tool: 'filter', label: 'Filter rows', group: 'Transforms' },
  { kind: 'transform', tool: 'map', label: 'Map fields', group: 'Transforms' },
  { kind: 'transform', tool: 'aggregate', label: 'Aggregate', group: 'Transforms' },
  { kind: 'transform', tool: 'ai-enrich', label: 'AI enrich', group: 'AI' },
  { kind: 'dest', tool: 'powerbi', label: 'Power BI', group: 'Destinations' },
  { kind: 'dest', tool: 'sheets', label: 'Google Sheets', group: 'Destinations' },
  { kind: 'dest', tool: 'webhook-out', label: 'Webhook', group: 'Destinations' },
];

export default function NodePicker({
  onSelect,
  onClose,
}: {
  onSelect: (entry: NodeCatalogEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = NODE_CATALOG.filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase()));
  const groups = Array.from(new Set(filtered.map((e) => e.group)));

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.28)', display: 'flex', justifyContent: 'flex-end', zIndex: 40 }}
      onClick={onClose}
    >
      <div
        style={{ width: 320, height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--line2)', padding: 16, overflowY: 'auto', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes\u2026"
          style={{ width: '100%', height: 36, borderRadius: 8, border: '1px solid var(--line2)', padding: '0 10px', fontSize: 13.5, marginBottom: 12, boxSizing: 'border-box' }}
        />
        {groups.map((group) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--ink4)',
                textTransform: 'uppercase',
                letterSpacing: '.04em',
                marginBottom: 6,
              }}
            >
              {group}
            </div>
            {filtered
              .filter((e) => e.group === group)
              .map((entry) => (
                <button
                  key={entry.tool}
                  type="button"
                  onClick={() => onSelect(entry)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    fontSize: 13.5,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                  }}
                >
                  {entry.label}
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

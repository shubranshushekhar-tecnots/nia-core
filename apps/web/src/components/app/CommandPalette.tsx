'use client';

import { modalCardStyle, modalOverlayStyle, modalTitleStyle } from './styles';

// Stub: full fuzzy command/search palette is a later phase. This just
// establishes the ⌘K entry point and empty-state treatment so the real
// implementation has somewhere to land.
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={{ ...modalCardStyle, width: 480 }} onClick={(e) => e.stopPropagation()}>
        <span style={modalTitleStyle}>Search</span>
        <input
          autoFocus
          placeholder="Search workflows, projects…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            height: 40,
            padding: '0 12px',
            fontFamily: 'inherit',
            fontSize: 14,
            color: 'var(--text)',
            background: 'var(--surface2)',
            border: '1px solid var(--line)',
            borderRadius: 9,
            outline: 'none',
          }}
        />
        <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>Coming soon.</p>
      </div>
    </div>
  );
}

'use client';

import { NxSearchIcon } from '@/components/canvas/navIcons';
import {
  nxCommandPaletteCardStyle,
  nxCommandPaletteEscStyle,
  nxCommandPaletteHeaderStyle,
  nxCommandPaletteHeaderTitleStyle,
  nxCommandPaletteInputStyle,
  nxCommandPaletteResultsRowStyle,
  nxCommandPaletteResultsTextStyle,
  nxCommandPaletteSearchRowStyle,
  nxCommandPaletteSoonBadgeStyle,
  nxModalOverlayStyle,
} from './styles';

// Stub: full fuzzy command/search palette is a later phase. This just
// establishes the ⌘K entry point and empty-state treatment so the real
// implementation has somewhere to land. Precision Dark redesign (Step 8A
// item 2) — matches HomeStates.dc.html's "COMMAND PALETTE · ⌘K · STUB"
// board. Render-only restyle; onClose/behavior unchanged.
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div role="dialog" aria-label="Search" style={nxCommandPaletteCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={nxCommandPaletteHeaderStyle}>
          <span style={nxCommandPaletteHeaderTitleStyle}>Search</span>
          <span style={nxCommandPaletteEscStyle}>ESC</span>
        </div>
        <label style={nxCommandPaletteSearchRowStyle}>
          <NxSearchIcon size={20} />
          <input
            autoFocus
            placeholder="Search workflows, projects…"
            aria-label="Search workflows, projects…"
            style={nxCommandPaletteInputStyle}
          />
        </label>
        <div style={nxCommandPaletteResultsRowStyle}>
          <span style={nxCommandPaletteSoonBadgeStyle}>Soon</span>
          <p style={nxCommandPaletteResultsTextStyle}>Coming soon.</p>
        </div>
      </div>
    </div>
  );
}

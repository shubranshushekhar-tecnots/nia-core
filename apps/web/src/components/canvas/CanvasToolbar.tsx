'use client';

import {
  viewportFullscreenBtnStyle,
  viewportToolbarBtnStyle,
  viewportToolbarDisabledBtnStyle,
  viewportToolbarDividerStyle,
  viewportToolbarStyle,
  viewportToolbarToggleBtnStyle,
} from './styles';
import { FitViewIcon, PanHandIcon, RedoIcon, SelectPointerIcon, UndoIcon } from './navIcons';

export type InteractionMode = 'pan' | 'select';

/**
 * Floating zoom/fit/interaction-mode/fullscreen cluster, bottom-left of the
 * canvas surface. Extracted from FlowCanvas.tsx's inline JSX so the toolbar
 * itself stays presentational — all handlers/state (zoom, fit, fullscreen,
 * interaction mode) are owned and wired up by FlowCanvas.tsx.
 *
 * Undo/Redo render permanently disabled: there is no history stack behind
 * the canvas today (a known data gap) — per the "don't invent
 * functionality" rule these are placeholders with a tooltip explaining
 * why, not fake buttons that silently do nothing.
 */
export default function CanvasToolbar({
  dockHeight,
  onZoomOut,
  onZoomIn,
  onFitView,
  interactionMode,
  onInteractionModeChange,
  isFullscreen,
  onToggleFullscreen,
}: {
  dockHeight: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitView: () => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <div style={viewportToolbarStyle(dockHeight)} data-testid="viewport-toolbar">
      <button
        type="button"
        style={viewportToolbarToggleBtnStyle(interactionMode === 'select')}
        onClick={() => onInteractionModeChange('select')}
        aria-pressed={interactionMode === 'select'}
        aria-label="Select mode"
        title="Select mode"
      >
        <SelectPointerIcon size={15} />
      </button>
      <button
        type="button"
        style={viewportToolbarToggleBtnStyle(interactionMode === 'pan')}
        onClick={() => onInteractionModeChange('pan')}
        aria-pressed={interactionMode === 'pan'}
        aria-label="Pan mode"
        title="Pan mode"
      >
        <PanHandIcon size={15} />
      </button>
      <div style={viewportToolbarDividerStyle} />
      <button type="button" style={viewportToolbarBtnStyle} onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
        {'\u2212'}
      </button>
      <button type="button" style={viewportToolbarBtnStyle} onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
        {'+'}
      </button>
      <button type="button" style={viewportToolbarBtnStyle} onClick={onFitView} aria-label="Fit view" title="Fit view">
        <FitViewIcon size={15} />
      </button>
      <div style={viewportToolbarDividerStyle} />
      <button type="button" style={viewportToolbarDisabledBtnStyle} disabled aria-label="Undo" title="Undo history isn't available yet">
        <UndoIcon size={15} />
      </button>
      <button type="button" style={viewportToolbarDisabledBtnStyle} disabled aria-label="Redo" title="Redo history isn't available yet">
        <RedoIcon size={15} />
      </button>
      <div style={viewportToolbarDividerStyle} />
      <button
        type="button"
        style={viewportFullscreenBtnStyle(isFullscreen)}
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? 'Exit full view' : 'Full view'}
        title={isFullscreen ? 'Exit full view' : 'Full view'}
      >
        <span aria-hidden>{isFullscreen ? '\u2716' : '\u26F6'}</span>
        {isFullscreen ? 'Exit full view' : 'Full view'}
      </button>
    </div>
  );
}

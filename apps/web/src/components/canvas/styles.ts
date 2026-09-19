import type { CSSProperties } from 'react';

/**
 * Workflow canvas redesign (docked rail / node popover / Copilot sidebar) —
 * new layout-level styles only. Existing per-file inline style consts
 * (NodeDrawer.tsx, TransformEditor.tsx, MappingEditor.tsx, ChecksDock.tsx)
 * stay where they are — this file holds ONLY the new docked-panel shell
 * styles introduced by this pass, per the "styles.ts per feature" convention
 * applying to new work, not a retroactive refactor of frozen files.
 */

// ---------- page root (icon rail | FlowCanvas column) ----------

// Replaces AppShell.tsx's shellRootStyle for this one route only — full
// viewport, icon rail + FlowCanvas as a row. See page.tsx's doc comment.
export const canvasPageRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'row',
  background: 'var(--canvas)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-ui)',
};

// ---------- shell row (rail | canvas-surface | copilot) ----------

export const canvasBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
};

export const canvasSurfaceStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  position: 'relative',
};

// Wraps canvas-surface + CopilotSidebar together so the browser Fullscreen
// API (requested on this element — see FlowCanvas.tsx's fullscreenRef)
// keeps Copilot visible instead of it disappearing along with everything
// else outside the fullscreened subtree. Explicit `background` is required
// here (not just inherited from canvasPageRootStyle) because a fullscreened
// element paints over the UA's default black `::backdrop` with its own
// background — without this, the canvas area renders black instead of
// `--canvas` while in full view.
export const canvasFullscreenWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
  background: 'var(--canvas)',
};

// Column holding NodeConfigPanel + canvasSurfaceStyle, inside
// canvasFullscreenWrapStyle's row — sits beside CopilotSidebar as a
// sibling, never spans it or NodesRail/the app header. `position: relative`
// is required here (not just on canvasSurfaceStyle) because
// NodeConfigPanel is a sibling of canvasSurfaceStyle, not a child of it —
// its `configPanelShellStyle` absolute positioning resolves against this
// column, which correctly sits below the header/rail.
export const canvasColumnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
};

// ---------- app icon rail (page-level, sibling of FlowCanvas — CanvasIconRail.tsx) ----------

// 56px collapsed / 200px expanded max — session-only `railW` state in
// CanvasIconRail.tsx, no persistence. Draggable via a handle on the rail's
// right edge (mirrors app/Sidebar.tsx's railW/RAIL_COLLAPSE_THRESHOLD
// pattern, just at this rail's own narrower scale) as well as a footer
// toggle button for a plain click-to-expand/collapse. Every row stays
// icon-first; expanding only reveals a label alongside each icon rather than
// restructuring row layout.
export const ICON_RAIL_WIDTH_COLLAPSED = 56;
export const ICON_RAIL_WIDTH_EXPANDED = 200;
// Below this live drag width the rail commits to fully collapsed rather
// than continuing to shrink further.
export const ICON_RAIL_COLLAPSE_THRESHOLD = 130;

export const iconRailStyle = (width: number, dragging: boolean): CSSProperties => {
  const expanded = width > ICON_RAIL_COLLAPSE_THRESHOLD;
  return {
    flex: 'none',
    width,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: expanded ? 'stretch' : 'center',
    background: 'var(--icon-rail-bg)',
    borderRight: '1px solid var(--panel-line)',
    padding: expanded ? '12px 8px' : '12px 0',
    boxSizing: 'border-box',
    position: 'relative',
    transition: dragging ? 'none' : 'width 150ms ease',
  };
};

export function iconRailHandleStyle(dragging: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -3,
    width: 7,
    zIndex: 12,
    cursor: 'col-resize',
    background: dragging ? 'var(--live)' : 'transparent',
    opacity: dragging ? 0.5 : 1,
    transition: 'background .12s ease',
  };
}

export const iconRailBtnStyle = (active: boolean, expanded: boolean): CSSProperties => ({
  flex: 'none',
  width: expanded ? '100%' : 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: expanded ? 'flex-start' : 'center',
  gap: 10,
  borderRadius: 8,
  fontSize: 15,
  color: active ? 'var(--acc-soft-text)' : 'var(--ink3)',
  background: active ? 'var(--acc-soft)' : 'none',
  border: 'none',
  cursor: 'pointer',
  marginBottom: 4,
  padding: expanded ? '0 8px' : 0,
  textDecoration: 'none',
  boxSizing: 'border-box',
});

export const iconRailBtnLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const iconRailExpandToggleStyle: CSSProperties = {
  flex: 'none',
  width: '100%',
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: 'none',
  background: 'none',
  color: 'var(--ink4)',
  cursor: 'pointer',
  fontSize: 12.5,
  marginTop: 4,
};

export const iconRailScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  overflowY: 'auto',
  width: '100%',
};

export const iconRailFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  paddingTop: 8,
  borderTop: '1px solid var(--panel-line)',
  width: '100%',
  position: 'relative',
};

// ---------- docked NodesRail ----------

export const railShellStyle = (wide: boolean): CSSProperties => ({
  flex: 'none',
  width: wide ? 'var(--rail-w)' : 'var(--rail-w-collapsed)',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  borderRight: '1px solid var(--panel-line)',
  overflow: 'hidden',
  transition: 'width 150ms ease',
});

export const railHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 14px 10px',
  flex: 'none',
};

export const railCollapseBtnStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--ink4)',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
};

export const railSearchWrapStyle: CSSProperties = { padding: '0 14px 10px', flex: 'none' };

export const railSearchInputStyle: CSSProperties = {
  width: '100%',
  height: 30,
  borderRadius: 6,
  border: '1px solid var(--panel-line)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--ink)',
  background: 'var(--surface2)',
};

export const railBodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 };

export const railSectionHeaderStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  margin: '10px 14px 6px',
};

// Borderless 36px row (replaces the old bordered card-style entry) — a
// colored icon tile stands in for the border as the row's sole visual
// anchor, per the redesign spec.
export const railEntryStyle = (draggable: boolean): CSSProperties => ({
  height: 36,
  padding: '0 10px 0 8px',
  margin: '0 8px 2px',
  borderRadius: 8,
  border: 'none',
  background: 'none',
  fontSize: 13,
  color: draggable ? 'var(--ink)' : 'var(--ink4)',
  cursor: draggable ? 'grab' : 'not-allowed',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const railEntryIconTileStyle = (color: string): CSSProperties => ({
  width: 22,
  height: 22,
  borderRadius: 6,
  flex: 'none',
  background: `${color}1F`,
  color,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  fontWeight: 700,
});

// Floating "Nodes N" re-expand pill, shown over the top-left of the canvas
// surface when the rail is collapsed (NodesRail.tsx renders `null` for its
// body in that state instead of the old icon-strip). `flex: 'none'` +
// `whiteSpace: 'nowrap'` keep the label on one line under flex pressure —
// same bug class fixed elsewhere in this file (headerBtnBaseStyle etc).
export const railReopenBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 20,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 999,
  boxShadow: 'var(--floating-panel-shadow)',
  padding: '6px 12px 6px 8px',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
};

export const railReopenBtnCountStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 999,
  background: 'var(--surface-2)',
  color: 'var(--ink3)',
  fontSize: 10.5,
  fontWeight: 700,
  lineHeight: 1,
};

export const railCollapsedToggleStyle: CSSProperties = {
  height: 40,
  flex: 'none',
  border: 'none',
  background: 'none',
  color: 'var(--ink4)',
  cursor: 'pointer',
  fontSize: 14,
};

// ---------- collapsed NodesRail (icon-only, still draggable) ----------

export const railCollapsedListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0 10px',
};

export const railCollapsedDividerStyle: CSSProperties = {
  width: 20,
  height: 1,
  background: 'var(--panel-line)',
  margin: '2px 0',
  flex: 'none',
};

export const railCollapsedEntryStyle = (draggable: boolean): CSSProperties => ({
  width: 32,
  height: 32,
  flex: 'none',
  position: 'relative',
  borderRadius: 8,
  border: '1px solid var(--panel-line)',
  background: 'var(--surface)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: draggable ? 'grab' : 'not-allowed',
  opacity: draggable ? 1 : 0.55,
});

export const railCollapsedEntryDotStyle = (color: string): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: 999,
  background: color,
  position: 'absolute',
  top: 4,
  right: 4,
});

export const railCollapsedEntryLabelStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--ink3)',
  textTransform: 'uppercase',
};

// ---------- node config panel (floating panel over the canvas, replaces the old docked top band) ----------

export const FLOATING_PANEL_WIDTH = 360;

// Absolutely positioned within canvasSurfaceStyle (which is `position:
// relative`) — inset 12px from the canvas's own top/right edges, not the
// viewport's, so it stays correctly placed inside the fullscreen/full-view
// subtree too. Capped to the surface's height minus its own inset so long
// content (e.g. MappingEditor's field list) scrolls internally instead of
// overflowing the canvas.
export const configPanelShellStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 25,
  width: FLOATING_PANEL_WIDTH,
  maxHeight: 'calc(100% - 24px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 14,
  boxShadow: 'var(--floating-panel-shadow)',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

// ---------- Setup / Field mapping tab bar (destination nodes only) ----------

export const panelTabBarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  height: 36,
  borderBottom: '1px solid var(--panel-line)',
  padding: '0 4px',
};

export const panelTabStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: 'none',
  height: 36,
  padding: '0 12px',
  fontSize: 13,
  fontWeight: 500,
  color: active ? 'var(--ink)' : 'var(--ink3)',
  borderBottom: active ? '2px solid var(--acc)' : '2px solid transparent',
  cursor: 'pointer',
  flex: 'none',
  whiteSpace: 'nowrap',
});

// Multi-select hint — a small standalone floating pill (nothing renders at
// all when selectedCount === 0; see NodeConfigPanel.tsx).
export const configPanelMultiSelectStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 25,
  width: FLOATING_PANEL_WIDTH,
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  color: 'var(--ink4)',
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 14,
  boxShadow: 'var(--floating-panel-shadow)',
  boxSizing: 'border-box',
};

// Content-swap crossfade wrapper (opacity only, no layout properties) —
// see NodeConfigPanel.tsx's FadeSwap.
export const configPanelFadeStyle = (visible: boolean): CSSProperties => ({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  opacity: visible ? 1 : 0,
  transition: 'opacity 160ms ease-out',
});

// Fixed height (not content-derived) so the header row never reflows
// between node types/selections.
export const CONFIG_PANEL_RIBBON_HEIGHT = 52;

export const configPanelRibbonStyle: CSSProperties = {
  flex: 'none',
  height: CONFIG_PANEL_RIBBON_HEIGHT,
  display: 'flex',
  alignItems: 'stretch',
  padding: '0 8px',
  borderBottom: '1px solid var(--panel-line)',
};

export const configPanelDetailStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '14px 16px',
};

export const configPanelDetailHintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink4)',
};

export const configPanelGroupStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 3,
  padding: '0 14px',
  minWidth: 0,
};

export const configPanelGroupLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  lineHeight: 1,
};

export const configPanelDividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '8px 0',
  background: 'var(--panel-line)',
  flex: 'none',
};

// Icon container for the ribbon header's connector/category identity icon
// (icons.tsx's getConnectorIcon) — `color` is set to the same KIND_COLOR
// value the old plain dot used, so the icon inherits it via `currentColor`.
export const configPanelIdentityIconStyle = (color: string): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color,
  flex: 'none',
});

export const segmentedControlStyle: CSSProperties = {
  display: 'flex',
  border: '1px solid var(--panel-line)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--surface2)',
  flex: 'none',
};

export const segmentedOptionStyle = (active: boolean, disabled: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--surface)' : 'none',
  color: disabled ? 'var(--ink4)' : active ? 'var(--ink)' : 'var(--ink3)',
  fontSize: 12,
  fontWeight: 600,
  padding: '0 10px',
  height: 26,
  cursor: disabled ? 'not-allowed' : 'pointer',
  boxShadow: active ? 'inset 0 0 0 1px var(--panel-line)' : 'none',
  whiteSpace: 'nowrap',
});

export const configPanelSelectStyle: CSSProperties = {
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--panel-line)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--ink)',
  background: 'var(--surface)',
  maxWidth: 200,
};

export const configPanelIconBtnStyle: CSSProperties = {
  border: '1px solid var(--panel-line)',
  background: 'var(--surface)',
  color: 'var(--ink3)',
  width: 26,
  height: 26,
  borderRadius: 7,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 12,
  flex: 'none',
};

export const configPanelDeleteBtnStyle: CSSProperties = {
  ...configPanelIconBtnStyle,
  color: 'var(--bad)',
};

// ---------- Copilot sidebar (docked right panel; wraps existing CommandBar) ----------

export const COPILOT_WIDTH_DEFAULT = 320;
export const COPILOT_WIDTH_MIN = 280;
export const COPILOT_WIDTH_MAX = 520;

// Curved on its left edge only — top/right/bottom stay flush with the
// screen/app edge (full height, no margin, square corners there), matching
// the reference rail's curved-left-only look. `width` is the live
// drag-resized value (CopilotSidebar.tsx local state, seeded from
// COPILOT_WIDTH_DEFAULT); no transition while `open` so drag-resize tracks
// the pointer 1:1, but the open/close toggle itself keeps its own
// open-flag-driven collapse.
export const copilotShellStyle = (open: boolean, width: number): CSSProperties => ({
  flex: 'none',
  width: open ? width : 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  background: 'var(--surface)',
  border: open ? '1px solid var(--panel-line)' : 'none',
  borderTopLeftRadius: open ? 16 : 0,
  borderBottomLeftRadius: open ? 16 : 0,
  boxShadow: open ? 'var(--drop)' : 'none',
  overflow: 'hidden',
});

// Shared left/top-edge drag-resize handle (mirrors Sidebar.tsx's
// railHandleStyle pointer-drag pattern) — used by CopilotSidebar's left
// edge (orientation 'vertical', drags width) and ChecksDock's top edge
// (orientation 'horizontal', drags height).
export const dragHandleStyle = (orientation: 'vertical' | 'horizontal', dragging: boolean): CSSProperties => ({
  position: 'absolute',
  zIndex: 5,
  background: dragging ? 'var(--acc)' : 'transparent',
  ...(orientation === 'vertical'
    ? { top: 0, bottom: 0, left: -3, width: 6, cursor: 'col-resize' }
    : { left: 0, right: 0, top: -3, height: 6, cursor: 'row-resize' }),
});

export const copilotToggleBtnStyle: CSSProperties = {
  border: '1px solid var(--panel-line)',
  background: 'var(--surface)',
  color: 'var(--ink3)',
  cursor: 'pointer',
  borderRadius: 12,
  width: 40,
  height: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 15,
  flex: 'none',
  boxShadow: '0 1px 2px rgba(15,23,42,.06)',
};

export const copilotHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid var(--panel-line)',
};

export const copilotTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--ink)' };

export const copilotSubtitleStyle: CSSProperties = { fontSize: 11.5, color: 'var(--ink3)' };

export const copilotChatAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
};

// ---------- top bar ----------

export const topBarStyle: CSSProperties = {
  flex: 'none',
  height: 48,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 16px',
  borderBottom: '1px solid var(--panel-line)',
  background: 'var(--surface)',
};

// ---------- header action buttons (Run checks / Run) ----------

export const headerBtnBaseStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  height: 30,
  borderRadius: 6,
  padding: '0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  boxSizing: 'border-box',
  flex: 'none',
  whiteSpace: 'nowrap',
};

export const headerRunChecksBtnStyle = (running: boolean): CSSProperties => ({
  ...headerBtnBaseStyle,
  color: 'var(--ink)',
  background: 'var(--surface2)',
  border: '1px solid var(--line2)',
  cursor: running ? 'wait' : 'pointer',
  opacity: running ? 0.6 : 1,
});

export const headerRunBtnStyle = (enabled: boolean, inFlight: boolean): CSSProperties => ({
  ...headerBtnBaseStyle,
  color: enabled || inFlight ? 'var(--onacc)' : 'var(--ink4)',
  background: enabled || inFlight ? 'var(--acc)' : 'var(--surface2)',
  border: `1px solid ${enabled || inFlight ? 'var(--acc)' : 'var(--line2)'}`,
  cursor: enabled ? 'pointer' : 'not-allowed',
});

export const headerCopilotToggleBtnStyle = (active: boolean): CSSProperties => ({
  ...headerBtnBaseStyle,
  color: active ? 'var(--acc-soft-text)' : 'var(--ink3)',
  background: active ? 'var(--acc-soft)' : 'none',
  border: `1px solid ${active ? 'var(--acc-soft-bd)' : 'var(--panel-line)'}`,
  cursor: 'pointer',
});

// Restores the design's real "Search or run ⌘K" input box (UI feedback item
// 5) — ported from app/styles.ts's topBarSearchBtnStyle/topBarKbdStyle, but
// `flex: '0 1 220px'` + `minWidth: 0` so it shrinks under width pressure
// (e.g. Copilot sidebar opening) instead of reflowing the rest of the
// header, per the user's explicit constraint.
export const headerSearchInputStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 30,
  flex: '0 1 220px',
  minWidth: 0,
  padding: '0 8px 0 10px',
  borderRadius: 8,
  background: 'var(--surface2)',
  border: '1px solid var(--panel-line)',
  color: 'var(--ink3)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

export const headerSearchLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const headerSearchKbdStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 11,
  padding: '2px 5px',
  borderRadius: 5,
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  color: 'var(--ink4)',
  lineHeight: 1,
  flex: 'none',
};

// ---------- full-view floating controls ----------

// Rendered only when the fullscreen subtree is active (FlowCanvas.tsx's
// isFullscreen) — the merged header/rail chrome is gone from view in that
// mode, so a minimal breadcrumb + action cluster floats over the canvas
// instead, positioned relative to canvasSurfaceStyle.
export const fullViewBreadcrumbStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 10,
  boxShadow: 'var(--floating-panel-shadow)',
  padding: '6px 12px',
  fontSize: 12.5,
  color: 'var(--ink)',
};

export const fullViewControlsStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 10,
  boxShadow: 'var(--floating-panel-shadow)',
  padding: 6,
};

// ---------- Copilot ghost-plan banner (Phase 7 Session 3 — Apply/Discard) ----------

export const planBannerStyle: CSSProperties = {
  position: 'absolute',
  top: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  maxWidth: 560,
  background: 'var(--surface)',
  border: '1px solid var(--copilot-accent)',
  borderRadius: 10,
  boxShadow: '0 4px 16px rgba(15,23,42,.10)',
  padding: '10px 12px',
};

export const planBannerTextStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--ink)',
  flex: 1,
  minWidth: 0,
};

export const planBannerApplyBtnStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--onacc)',
  background: 'var(--acc)',
  border: '1px solid var(--acc)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  flex: 'none',
};

export const planBannerDiscardBtnStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--ink3)',
  background: 'var(--surface2)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  flex: 'none',
};

export const planBannerErrorStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--bad)',
  flex: 'none',
};

// ---------- viewport toolbar (zoom / fit / fullscreen) ----------

// ChecksDock is a full-width absolutely-positioned bottom bar (36px
// collapsed, drag-resizable when expanded — see ChecksDock.tsx's dockStyle)
// that sits at a higher zIndex (30) than this toolbar (20), so a fixed
// `bottom: 16` here used to render partly underneath/behind it. Lift the
// toolbar to clear the dock's live height instead (`dockHeight` is
// ChecksDock's own collapsed(36)/expanded(drag height) total, threaded down
// from FlowCanvas.tsx rather than re-derived here).
export const viewportToolbarStyle = (dockHeight: number): CSSProperties => ({
  position: 'absolute',
  left: 16,
  bottom: dockHeight + 16,
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderRadius: 10,
  boxShadow: '0 4px 16px rgba(15,23,42,.10)',
  padding: 4,
  transition: 'bottom 150ms ease',
});

export const viewportToolbarBtnStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--ink3)',
  cursor: 'pointer',
  width: 28,
  height: 28,
  borderRadius: 6,
  fontSize: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const viewportToolbarDividerStyle: CSSProperties = {
  width: 1,
  height: 20,
  background: 'var(--panel-line)',
  margin: '0 2px',
  flex: 'none',
};

// Labeled (not icon-only) so "full view" reads as a distinct, deliberate
// action rather than blending into the zoom/fit icon cluster.
export const viewportFullscreenBtnStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--surface2)' : 'none',
  color: active ? 'var(--ink)' : 'var(--ink3)',
  cursor: 'pointer',
  height: 28,
  borderRadius: 6,
  fontSize: 12.5,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 10px 0 8px',
  whiteSpace: 'nowrap',
});

import type { CSSProperties } from 'react';

/**
 * Workflow canvas redesign (docked rail / node popover / Copilot sidebar) —
 * new layout-level styles only. Existing per-file inline style consts
 * (NodeDrawer.tsx, TransformEditor.tsx, MappingEditor.tsx, ChecksDock.tsx)
 * stay where they are — this file holds ONLY the new docked-panel shell
 * styles introduced by this pass, per the "styles.ts per feature" convention
 * applying to new work, not a retroactive refactor of frozen files.
 */

// ---------- page root (header on top, icon rail | FlowCanvas below) ----------

// Mirrors AppShell.tsx's shellRootStyle/shellBodyStyle split exactly (full-
// width header strip on top, Sidebar + content row below it) so the rail
// sits in the same place on every /app/* route — this route used to put
// the header only above the content column (row: rail | header+canvas),
// leaving the rail's own logo flush with the viewport top instead of
// sitting below the header like everywhere else. Column now, not row; see
// canvasShellRowStyle for the row underneath.
export const canvasPageRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-ui)',
};

// Sidebar + canvasBodyStyle row, below CanvasHeader — the canvas-route
// equivalent of app/styles.ts's shellBodyStyle.
export const canvasShellRowStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
};

// ---------- shell row (rail | canvas-surface | copilot) ----------

export const canvasBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
};

export const canvasSurfaceStyle: CSSProperties = {
  flex: '1 1 auto',
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
  background: 'var(--nx-bg)',
};

// Row holding canvasSurfaceStyle + NodeConfigPanel as real flex siblings
// (workflow canvas redesign — was an absolutely-positioned floating overlay
// over the canvas; now the canvas visibly shrinks to make room for a docked
// inspector, per spec). Sits beside CopilotSidebar as its own sibling
// inside canvasFullscreenWrapStyle's row, never spanning it or NodesRail/
// the app header.
export const canvasColumnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
  position: 'relative',
};

// ---------- docked NodesRail ----------

export const railShellStyle = (wide: boolean): CSSProperties => ({
  flex: 'none',
  width: wide ? 'var(--rail-w)' : 'var(--rail-w-collapsed)',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-surface)',
  borderRight: '1px solid var(--nx-line)',
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
  color: 'var(--nx-ink-disabled)',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
};

export const railSearchWrapStyle: CSSProperties = { padding: '0 14px 10px', flex: 'none' };

export const railSearchInputStyle: CSSProperties = {
  width: '100%',
  height: 30,
  borderRadius: 6,
  border: '1px solid var(--nx-line)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--nx-ink)',
  background: 'var(--nx-raised)',
};

export const railBodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 };

export const railSectionHeaderStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--nx-ink-disabled)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  margin: '10px 14px 6px',
};

// Borderless 36px row (replaces the old bordered card-style entry) — a
// colored icon tile stands in for the border as the row's sole visual
// anchor, per the redesign spec.
export const railEntryStyle = (draggable: boolean): CSSProperties => ({
  height: 44,
  padding: '0 10px 0 8px',
  margin: '0 8px 2px',
  borderRadius: 8,
  border: 'none',
  background: 'none',
  fontSize: 13,
  color: draggable ? 'var(--nx-ink)' : 'var(--nx-ink-disabled)',
  cursor: draggable ? 'grab' : 'not-allowed',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const railEntryIconTileStyle = (color: string, size = 22): CSSProperties => ({
  width: size,
  height: size,
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
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 999,
  boxShadow: 'var(--floating-panel-shadow)',
  padding: '6px 12px 6px 8px',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--nx-ink)',
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
  background: 'var(--nx-raised)',
  color: 'var(--nx-ink-3)',
  fontSize: 10.5,
  fontWeight: 700,
  lineHeight: 1,
};

// Small pill on an installed-but-not-yet-connected entry (NodesRail.tsx) —
// same visual language as railReopenBtnCountStyle's badge, just inline
// instead of floating.
export const railEntryConnectBadgeStyle: CSSProperties = {
  flex: 'none',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--nx-ink-disabled)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 999,
  padding: '1px 6px',
};

// Right-click context menu on a NodesRail entry ("Add connection"). Fixed
// positioning at the click point, same floating-panel shadow/border as the
// rest of the canvas chrome (railReopenBtnStyle, NodeConfigPanel).
export const railContextMenuStyle = (x: number, y: number): CSSProperties => ({
  position: 'fixed',
  top: y,
  left: x,
  zIndex: 50,
  minWidth: 160,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  boxShadow: 'var(--floating-panel-shadow)',
  padding: 4,
});

// Trailing "+ Add connection" row appended after a connector's real
// connection rows (NodesRail.tsx) — lets a connector with N connections
// (e.g. two Supabase DBs) always keep an explicit way to add connection
// N+1, instead of that affordance disappearing once at least one
// connection exists. Dashed border distinguishes it from both the solid
// connected rows above it and the muted (but solid-border-less)
// not-yet-connected placeholder row.
export const railAddEntryStyle: CSSProperties = {
  height: 36,
  padding: '0 10px 0 8px',
  margin: '0 8px 2px',
  borderRadius: 8,
  border: '1px dashed var(--nx-line)',
  background: 'none',
  fontSize: 12.5,
  color: 'var(--nx-ink-disabled)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const railContextMenuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'none',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 12.5,
  color: 'var(--nx-ink)',
  cursor: 'pointer',
};

export const railCollapsedToggleStyle: CSSProperties = {
  height: 40,
  flex: 'none',
  border: 'none',
  background: 'none',
  color: 'var(--nx-ink-disabled)',
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
  background: 'var(--nx-line)',
  margin: '2px 0',
  flex: 'none',
};

export const railCollapsedEntryStyle = (draggable: boolean): CSSProperties => ({
  width: 32,
  height: 32,
  flex: 'none',
  position: 'relative',
  borderRadius: 8,
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
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
  color: 'var(--nx-ink-3)',
  textTransform: 'uppercase',
};

// ---------- node config panel (docked inspector, flex sibling of the canvas surface) ----------

export const FLOATING_PANEL_WIDTH = 360;

// Real flex sibling of canvasSurfaceStyle inside canvasColumnStyle's row
// (workflow canvas redesign — was `position: absolute`, floating over the
// canvas; the canvas now visibly shrinks by FLOATING_PANEL_WIDTH instead).
// `flex: '0 0 360px'` fixes its width regardless of the canvas's own size;
// `overflow: auto` (not the old shell's `hidden`) lets long content (e.g.
// MappingEditor's field list) scroll internally without a fixed maxHeight
// calc, since height now comes from the flex row's own cross-axis stretch.
export const configPanelShellStyle: CSSProperties = {
  flex: '0 0 360px',
  width: FLOATING_PANEL_WIDTH,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-surface)',
  borderLeft: '1px solid var(--nx-line)',
  boxSizing: 'border-box',
  overflow: 'auto',
};

// ---------- Setup / Field mapping tab bar (destination nodes only) ----------

export const panelTabBarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  height: 36,
  borderBottom: '1px solid var(--nx-line)',
  padding: '0 4px',
};

export const panelTabStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: 'none',
  height: 36,
  padding: '0 12px',
  fontSize: 13,
  fontWeight: 500,
  color: active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
  borderBottom: active ? '2px solid var(--nx-blue-panel)' : '2px solid transparent',
  cursor: 'pointer',
  flex: 'none',
  whiteSpace: 'nowrap',
});

// Multi-select hint — same docked-sibling treatment as configPanelShellStyle
// above (nothing renders at all when selectedCount === 0; see
// NodeConfigPanel.tsx).
export const configPanelMultiSelectStyle: CSSProperties = {
  flex: '0 0 360px',
  width: FLOATING_PANEL_WIDTH,
  minWidth: 0,
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  color: 'var(--nx-ink-disabled)',
  background: 'var(--nx-surface)',
  borderLeft: '1px solid var(--nx-line)',
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
  // minHeight, not a fixed height — 52px covers the single-line case (which
  // never reflows), but a long connection/host name now wraps onto a second
  // line instead of truncating, so the ribbon has to be free to grow for it.
  minHeight: CONFIG_PANEL_RIBBON_HEIGHT,
  display: 'flex',
  alignItems: 'stretch',
  padding: '0 8px',
  borderBottom: '1px solid var(--nx-line)',
};

export const configPanelDetailStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '14px 16px',
};

export const configPanelDetailHintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-disabled)',
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
  color: 'var(--nx-ink-disabled)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  lineHeight: 1,
};

export const configPanelDividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '8px 0',
  background: 'var(--nx-line)',
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
  border: '1px solid var(--nx-line)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--nx-raised)',
  flex: 'none',
};

export const segmentedOptionStyle = (active: boolean, disabled: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--nx-surface)' : 'none',
  color: disabled ? 'var(--nx-ink-disabled)' : active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
  fontSize: 12,
  fontWeight: 600,
  padding: '0 10px',
  height: 26,
  cursor: disabled ? 'not-allowed' : 'pointer',
  boxShadow: active ? 'inset 0 0 0 1px var(--nx-line)' : 'none',
  whiteSpace: 'nowrap',
});

export const configPanelSelectStyle: CSSProperties = {
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--nx-line)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--nx-ink)',
  background: 'var(--nx-surface)',
  maxWidth: 200,
};

export const configPanelIconBtnStyle: CSSProperties = {
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink-3)',
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
  color: 'var(--nx-danger)',
};

// ---------- NodeDrawer footer (live node status) + needsAction alert card ----------
// Reuses the exact same status-color tokens as GraphFlowNode.tsx's on-canvas
// footer (mapping.ts's `data.status` is one merge pass shared by both), so
// a node's color language never disagrees between the canvas card and its
// inspector.

export const configPanelFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 14px',
  borderTop: '1px solid var(--nx-line)',
  fontSize: 11.5,
  color: 'var(--nx-ink-2)',
};

export const configPanelStatusDotStyle = (color: string): CSSProperties => ({
  flex: 'none',
  width: 6,
  height: 6,
  borderRadius: 999,
  background: color,
});

// Amber (or red, for a failed check) alert card shown at the top of the
// scrollable detail body whenever data.status.kind is 'needsAction' or
// 'failed' — the footer strip alone is easy to miss below the fold, so a
// real check failure/warning also gets this more prominent inline callout.
export const configPanelAlertCardStyle = (tone: 'warning' | 'danger'): CSSProperties => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  marginBottom: 12,
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.4,
  color: tone === 'warning' ? 'var(--nx-warn)' : 'var(--nx-danger-text)',
  background: tone === 'warning' ? 'var(--nx-raised)' : 'var(--nx-danger-tint)',
  border: `1px solid ${tone === 'warning' ? 'var(--nx-warn)' : 'var(--nx-danger)'}`,
});

// ---------- Copilot sidebar (docked right panel; wraps existing CommandBar) ----------

export const COPILOT_WIDTH_DEFAULT = 320;
export const COPILOT_WIDTH_MIN = 280;
export const COPILOT_WIDTH_MAX = 920;

// Curved on its left edge only — top/right/bottom stay flush with the
// screen/app edge (full height, no margin, square corners there), matching
// the reference rail's curved-left-only look. `width` is the live
// drag-resized value (CopilotSidebar.tsx local state, seeded from
// COPILOT_WIDTH_DEFAULT); no transition while `open` so drag-resize tracks
// the pointer 1:1, but the open/close toggle itself keeps its own
// open-flag-driven collapse. Step 5 answer "panels go to 0": radius flattened
// to var(--nx-radius) along with the rest of the canvas's floating chrome.
export const copilotShellStyle = (open: boolean, width: number): CSSProperties => ({
  flex: 'none',
  width: open ? width : 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  background: 'var(--nx-surface)',
  border: open ? '1px solid var(--nx-line)' : 'none',
  borderTopLeftRadius: open ? 'var(--nx-radius)' : 0,
  borderBottomLeftRadius: open ? 'var(--nx-radius)' : 0,
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
  background: dragging ? 'var(--nx-blue-panel)' : 'transparent',
  ...(orientation === 'vertical'
    ? { top: 0, bottom: 0, left: -3, width: 6, cursor: 'col-resize' }
    : { left: 0, right: 0, top: -3, height: 6, cursor: 'row-resize' }),
});

export const copilotToggleBtnStyle: CSSProperties = {
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink-3)',
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
  borderBottom: '1px solid var(--nx-line)',
};

export const copilotTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--nx-ink)' };

export const copilotSubtitleStyle: CSSProperties = { fontSize: 11.5, color: 'var(--nx-ink-3)' };

export const copilotChatAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
};

// ---------- top bar ----------
//
// CanvasHeader now imports the shared `topBarStyle` from app/styles.ts
// instead of a local copy — this file used to define its own (48px,
// `--panel-line` border) which drifted from the app shell's TopBar (52px,
// `--line` border), producing a visible header height/border jump when
// navigating between /app pages and the workflow canvas.

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
  color: 'var(--nx-ink)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  cursor: running ? 'wait' : 'pointer',
  opacity: running ? 0.6 : 1,
});

export const headerRunBtnStyle = (enabled: boolean, inFlight: boolean): CSSProperties => ({
  ...headerBtnBaseStyle,
  color: enabled || inFlight ? 'var(--nx-blue-cta-text)' : 'var(--nx-ink-disabled)',
  background: enabled || inFlight ? 'var(--nx-blue-cta)' : 'var(--nx-raised)',
  border: `1px solid ${enabled || inFlight ? 'var(--nx-blue-cta)' : 'var(--nx-line)'}`,
  cursor: enabled ? 'pointer' : 'not-allowed',
});

export const headerCopilotToggleBtnStyle = (active: boolean): CSSProperties => ({
  ...headerBtnBaseStyle,
  color: active ? 'var(--nx-blue-soft-text)' : 'var(--nx-ink-3)',
  background: active ? 'var(--nx-blue-tint)' : 'none',
  border: `1px solid ${active ? 'var(--nx-blue-panel)' : 'var(--nx-line)'}`,
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
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-3)',
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
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  padding: '2px 5px',
  borderRadius: 5,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-disabled)',
  lineHeight: 1,
  flex: 'none',
};

// Static (never mutates workflow.status) — no publish/draft transition flow
// exists today, so this only ever reflects the value already on the record.
export const headerDraftChipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--nx-ink-3)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 5,
  padding: '2px 7px',
  lineHeight: 1.4,
  flex: 'none',
};

// Always disabled — no PATCH /workflows/:id (rename) endpoint exists yet
// (data gap). Styled to sit flush next to pageCrumbCurrentStyle's name text
// so the pencil reads as "renaming lives here" without implying it works.
export const headerRenameBtnStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--nx-ink-disabled)',
  cursor: 'not-allowed',
  width: 20,
  height: 20,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  opacity: 0.6,
};

// Editor | Runs | Schedule segmented control. Only "Editor" is ever wired
// (Runs/Schedule have no routes yet — rendered disabled with a "Coming
// soon" tooltip, never a fake active state).
export const headerTabsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 8,
  padding: 2,
  flex: 'none',
};

export const headerTabBtnStyle = (active: boolean, disabled: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--nx-surface)' : 'none',
  color: disabled ? 'var(--nx-ink-disabled)' : active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
  boxShadow: active ? '0 1px 2px rgba(15,23,42,.08)' : 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 12,
  fontWeight: 600,
  height: 24,
  borderRadius: 6,
  padding: '0 10px',
  opacity: disabled ? 0.55 : 1,
});

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
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  boxShadow: 'var(--floating-panel-shadow)',
  padding: '6px 12px',
  fontSize: 12.5,
  color: 'var(--nx-ink)',
};

export const fullViewControlsStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
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
  background: 'var(--nx-surface)',
  border: '1px solid var(--copilot-accent)',
  borderRadius: 'var(--nx-radius)',
  boxShadow: '0 4px 16px rgba(15,23,42,.10)',
  padding: '10px 12px',
};

export const planBannerTextStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--nx-ink)',
  flex: 1,
  minWidth: 0,
};

export const planBannerApplyBtnStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--nx-blue-cta-text)',
  background: 'var(--nx-blue-cta)',
  border: '1px solid var(--nx-blue-cta)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  flex: 'none',
};

export const planBannerDiscardBtnStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--nx-ink-3)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  flex: 'none',
};

export const planBannerErrorStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--nx-danger)',
  flex: 'none',
};

// ---------- Phase 12 — applied-plans Revert list (CommandBar.tsx) ----------
// "Keep it plain" per the Phase 12 plan (Step 2E) — a simple bordered list,
// no new visual language beyond existing thread/chip tokens.

export const appliedPlansSectionStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 16px',
  borderBottom: '1px solid var(--nx-line)',
};

export const appliedPlansTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--nx-ink-disabled)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};

export const appliedPlanRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0',
  borderBottom: '1px solid var(--nx-line)',
};

export const appliedPlanSummaryStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const appliedPlanRevertBtnStyle: CSSProperties = {
  flex: 'none',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--nx-ink-3)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
};

export const appliedPlanRevertedTagStyle: CSSProperties = {
  flex: 'none',
  fontSize: 11,
  color: 'var(--nx-ink-disabled)',
};

export const appliedPlanErrorStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--nx-danger)',
};

// ---------- Copilot agent tool-call cards (docs/plans/copilot-agent.md, Part 3/4) ----------
// Rendered under a "//"-command assistant bubble in CommandBar.tsx, keyed
// off agentRenders[m.id]. Deliberately plain, same visual language as the
// applied-plans list above — a bordered block is enough, no new tokens.

export const agentCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 8,
  padding: '10px 12px',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--copilot-accent)',
};

export const agentCardTitleStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};

export const agentCardEntryStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const agentCardConfirmBtnStyle = (disabled: boolean): CSSProperties => ({
  alignSelf: 'flex-start',
  fontSize: 12.5,
  fontWeight: 600,
  color: disabled ? 'var(--nx-ink-disabled)' : 'var(--nx-blue-cta-text)',
  background: disabled ? 'var(--nx-raised)' : 'var(--nx-blue-cta)',
  border: `1px solid ${disabled ? 'var(--nx-line)' : 'var(--nx-blue-cta)'}`,
  borderRadius: 6,
  padding: '6px 12px',
  cursor: disabled ? 'default' : 'pointer',
});

// Post-confirm / no-confirmation-needed acknowledgement (graph_applied,
// runs_started) — a small "done" pill, not a full card.
export const agentCardBadgeStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--nx-success)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 999,
  padding: '3px 10px',
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
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  boxShadow: '0 4px 16px rgba(15,23,42,.10)',
  padding: 4,
  transition: 'bottom 150ms ease',
});

export const viewportToolbarBtnStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--nx-ink-3)',
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
  background: 'var(--nx-line)',
  margin: '0 2px',
  flex: 'none',
};

// Labeled (not icon-only) so "full view" reads as a distinct, deliberate
// action rather than blending into the zoom/fit icon cluster.
export const viewportFullscreenBtnStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--nx-raised)' : 'none',
  color: active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
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

// Select/Pan interaction-mode toggle pair — same 28px square footprint as
// viewportToolbarBtnStyle, but with a persistent "active" affordance (filled
// background) since, unlike zoom/fit, this reflects ongoing canvas state
// rather than a one-shot action.
export const viewportToolbarToggleBtnStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: active ? 'var(--nx-raised)' : 'none',
  color: active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
  cursor: 'pointer',
  width: 28,
  height: 28,
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

// Undo/Redo currently have no backing history stack (canvas-redesign data
// gap) so they always render in this disabled visual state; kept separate
// from viewportToolbarBtnStyle so a future history implementation can wire
// real enabled/disabled states without touching the base button style.
export const viewportToolbarDisabledBtnStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--nx-ink-disabled)',
  cursor: 'not-allowed',
  width: 28,
  height: 28,
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0.5,
};

// ---------- CommandBar "/" command menu (docs/plans/copilot-command-menu.md) ----------
// Replaces CommandBar.tsx's old flat chatSlashMenu* list: a grouped,
// scrollable command list with a bottom tab strip (Commands | Recent | AI
// Command). Same visual language as chatSlashMenu*/chatMention* in
// app/styles.ts (card dropdown positioned against the bar), but taller and
// split into an internally-scrolling list plus a fixed-height tab strip so
// the tab row is never clipped by maxHeight/viewport edges.

/** `placement` flips the panel above (default, room permitting) or below the input — see CommandMenu.tsx's viewport-space check. */
export const commandMenuPanelStyle = (placement: 'above' | 'below'): CSSProperties => ({
  position: 'absolute',
  left: 0,
  right: 0,
  ...(placement === 'above' ? { bottom: '100%', marginBottom: 8 } : { top: '100%', marginTop: 8 }),
  maxHeight: 360,
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  boxShadow: 'var(--amb)',
  overflow: 'hidden',
  zIndex: 5,
});

export const commandMenuListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const commandMenuGroupHeaderStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 10.5,
  fontWeight: 500,
  color: 'var(--nx-ink-disabled)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  padding: '10px 10px 4px',
};

export const commandMenuRowStyle = (active: boolean): CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  borderRadius: 8,
  background: active ? 'var(--nx-raised)' : 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
});

export const commandMenuRowIconStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  color: 'var(--nx-ink-3)',
};

export const commandMenuRowNameStyle: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--nx-ink)',
};

export const commandMenuRowDescStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 11.5,
  color: 'var(--nx-ink-disabled)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Single muted hint line at the bottom of the panel, directly above the
 * tab strip — shows the highlighted command's "name — description" in
 * place of the old per-row title tooltip/inline description. */
export const commandMenuHintStyle: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 11.5,
  fontWeight: 400,
  color: 'var(--nx-ink-disabled)',
  padding: '7px 12px',
  borderTop: '1px solid var(--nx-line)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const commandMenuEmptyStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  padding: '16px 10px',
  fontSize: 12.5,
  color: 'var(--nx-ink-disabled)',
  textAlign: 'center',
};

export const commandMenuTabStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 6px',
  borderTop: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
};

export const commandMenuTabBtnStyle = (active: boolean): CSSProperties => ({
  fontFamily: 'var(--nx-font-ui)',
  border: 'none',
  background: active ? 'var(--nx-raised)' : 'none',
  color: active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
  cursor: 'pointer',
  height: 26,
  borderRadius: 6,
  fontSize: 11.5,
  fontWeight: 500,
  padding: '0 9px',
  whiteSpace: 'nowrap',
});

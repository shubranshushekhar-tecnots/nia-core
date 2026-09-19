import type { CSSProperties } from 'react';

/**
 * Workflow canvas redesign (docked rail / node popover / Copilot sidebar) —
 * new layout-level styles only. Existing per-file inline style consts
 * (NodeDrawer.tsx, TransformEditor.tsx, MappingEditor.tsx, ChecksDock.tsx)
 * stay where they are — this file holds ONLY the new docked-panel shell
 * styles introduced by this pass, per the "styles.ts per feature" convention
 * applying to new work, not a retroactive refactor of frozen files.
 */

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
// else outside the fullscreened subtree.
export const canvasFullscreenWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
};

// Column holding NodeConfigPanel (fixed height, always mounted) above
// canvasSurfaceStyle, inside canvasFullscreenWrapStyle's row — sits beside
// CopilotSidebar as a sibling, never spans it or NodesRail/the app header.
export const canvasColumnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
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

export const railEntryStyle = (draggable: boolean): CSSProperties => ({
  padding: '8px 10px',
  margin: '0 12px 6px',
  borderRadius: 8,
  border: '1px solid var(--panel-line)',
  background: 'var(--surface)',
  fontSize: 13,
  color: draggable ? 'var(--ink)' : 'var(--ink4)',
  cursor: draggable ? 'grab' : 'not-allowed',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

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

// ---------- node config panel (docked top band, replaces the old anchored popover) ----------

// Two fixed rows: a compact always-visible "ribbon" (identity + verb/table
// controls + actions) and a reserved "detail" strip beneath it for the
// heavier per-node-type editors (grant/revoke, field mapping, transform
// steps). Both heights are constants (not derived from content) so the
// panel never grows/shrinks across node types or selections — the canvas
// below it never jumps.
export const CONFIG_PANEL_RIBBON_HEIGHT = 44;
export const CONFIG_PANEL_DETAIL_HEIGHT = 132;
export const CONFIG_PANEL_HEIGHT = CONFIG_PANEL_RIBBON_HEIGHT + CONFIG_PANEL_DETAIL_HEIGHT;

export const configPanelShellStyle: CSSProperties = {
  flex: 'none',
  height: CONFIG_PANEL_HEIGHT,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  borderBottom: '1px solid var(--panel-line)',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

// Empty/multi-select hint state — same fixed height as the populated
// ribbon+detail rows combined, so selecting/deselecting a node never
// resizes this container.
export const configPanelEmptyStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  color: 'var(--ink4)',
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
  padding: '10px 16px',
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

export const configPanelIdentityDotStyle = (color: string): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: 999,
  background: color,
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

// Curved on its left edge only — top/right/bottom stay flush with the
// screen/app edge (full height, no margin, square corners there), matching
// the reference rail's curved-left-only look.
export const copilotShellStyle = (open: boolean): CSSProperties => ({
  flex: 'none',
  width: open ? 'var(--copilot-w)' : 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  border: open ? '1px solid var(--panel-line)' : 'none',
  borderTopLeftRadius: open ? 16 : 0,
  borderBottomLeftRadius: open ? 16 : 0,
  boxShadow: open ? 'var(--drop)' : 'none',
  overflow: 'hidden',
  transition: 'width 150ms ease',
});

export const copilotCollapsedRailStyle: CSSProperties = {
  flex: 'none',
  width: 64,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 16,
  paddingTop: 16,
  background: 'var(--surface)',
  border: '1px solid var(--panel-line)',
  borderTopLeftRadius: 16,
  borderBottomLeftRadius: 16,
  boxShadow: 'var(--drop)',
};

export const copilotCollapsedLogoStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 999,
  flex: 'none',
  objectFit: 'cover',
};

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

export const copilotHeaderLogoStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  flex: 'none',
  objectFit: 'cover',
};

export const copilotTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--ink)' };

export const copilotSubtitleStyle: CSSProperties = { fontSize: 10.5, color: 'var(--ink4)' };

export const copilotComingSoonBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--warn)',
  background: 'var(--warn-bg)',
  border: '1px solid var(--warn-bd)',
  borderRadius: 999,
  padding: '2px 7px',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};

export const copilotMockSectionStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '9px 16px',
  borderBottom: '1px solid var(--panel-line)',
  background: 'var(--surface2)',
  fontSize: 11.5,
  color: 'var(--ink3)',
  lineHeight: 1.4,
};

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
  height: 56,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 16px',
  borderBottom: '1px solid var(--panel-line)',
  background: 'var(--surface)',
};

// ---------- viewport toolbar (zoom / fit / fullscreen) ----------

// ChecksDock is a full-width absolutely-positioned bottom bar (40px tab
// bar, up to +260px body when expanded — see ChecksDock.tsx's dockStyle/
// bodyStyle) that sits at a higher zIndex (30) than this toolbar (20), so
// a fixed `bottom: 16` here used to render partly underneath/behind it.
// Lift the toolbar to clear the dock's current height instead.
export const viewportToolbarStyle = (checksDockExpanded: boolean): CSSProperties => ({
  position: 'absolute',
  left: 16,
  bottom: checksDockExpanded ? 316 : 56,
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

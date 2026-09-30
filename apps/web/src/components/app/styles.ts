import type { CSSProperties } from 'react';

// App shell (post-login): sidebar, top bar, home dashboard. Scoped under
// [data-app-theme] (Midnight Navy dark / Warm White light) — see
// packages/ui/src/theme.css. Tokens only, no hardcoded hex.

export const RAIL_WIDTH = 240;
export const RAIL_COLLAPSED_WIDTH = 64;
export const RAIL_MIN_WIDTH = 168;
export const RAIL_MAX_WIDTH = 360;
// Below this live drag width the rail commits to fully collapsed
// (RAIL_COLLAPSED_WIDTH) rather than continuing to shrink further.
export const RAIL_COLLAPSE_THRESHOLD = 150;

export const shellRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  // Precision Dark redesign (Phase 1, UI-1): app background + body text read
  // from the --nx-* tokens (packages/ui/src/theme.css) instead of --bg/--text
  // so the shell responds to the dark/light theme switcher. Nothing else in
  // this file/step reads --nx-* yet.
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--font-ui)',
  WebkitFontSmoothing: 'antialiased',
};

// Sidebar + page content row, below the full-width TopBar strip.
export const shellBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
};

// railW/suppressTransition drive the resizable rail exactly like the
// design's `sidebarStyle` computed string (state.railW + state.railDrag) —
// width is a live pixel value, not a two-state collapsed/expanded boolean.
// `suppressTransition` is true only while actively dragging AND the width
// is tracking the pointer 1:1 (so the rail never lags behind the cursor);
// it's false for the normal double-click reset AND for the moment the
// live drag crosses the collapse/expand threshold, so that specific snap
// still eases in smoothly instead of teleporting mid-drag.
export function sidebarStyle(railW: number, suppressTransition: boolean): CSSProperties {
  return {
    width: railW,
    flex: 'none',
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface)',
    borderRight: '1px solid var(--line)',
    transition: suppressTransition ? 'none' : 'width .2s cubic-bezier(.16,.84,.3,1)',
    overflow: 'hidden',
  };
}

// Drag handle on the rail's right edge — matches the design's
// `railHandleStyle` (7px hit target, highlights with --live while dragging).
export function railHandleStyle(dragging: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    right: -3,
    bottom: 0,
    width: 7,
    zIndex: 12,
    cursor: 'col-resize',
    background: dragging ? 'var(--live)' : 'transparent',
    opacity: dragging ? 0.5 : 1,
    transition: 'background .12s ease',
  };
}

// Ported from the design's `createBtnStyle` (height:32px, font-size:13px,
// font-weight:500) — was 36/13.5/600 here, visibly too tall/bold.
export const createWorkflowBtnStyle: CSSProperties = {
  margin: '14px 14px 12px',
  height: 32,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--bg)',
  background: 'var(--text)',
  border: 'none',
  borderRadius: 9,
  cursor: 'pointer',
};

export const navScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0 10px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const navGroupLabelStyle: CSSProperties = {
  padding: '14px 8px 6px',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

// `wide=false` renders the icon-only collapsed-rail row: centered icon,
// no horizontal padding (the icon centers itself in the 64px rail rather
// than sitting flush left where the label used to start).
export function navItemStyle(active: boolean, wide: boolean = true): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 9,
    height: 32,
    boxSizing: 'border-box',
    padding: wide ? '0 8px' : 0,
    borderRadius: 7,
    fontSize: 13.5,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--live)' : 'var(--text-2)',
    background: active ? 'var(--live-dim)' : 'transparent',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

// "Projects" parent disclosure row — icon + label + chevron pinned right,
// sits directly under the PROJECTS section label, toggles the project tree
// below it AND navigates to the /app/projects list page (design's `n.tree`
// click handler does both: `navProjectsOpen:!st.navProjectsOpen,
// page:'projects'`). Active whenever the list page, a project detail page,
// or a workflow canvas is open (design's `n.id==='projects' &&
// (s.page==='project'||s.page==='automation')` clause).
export function projectsParentRowStyle(active: boolean, wide: boolean = true): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 9,
    height: 32,
    boxSizing: 'border-box',
    padding: wide ? '0 8px' : 0,
    borderRadius: 7,
    fontSize: 13.5,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--live)' : 'var(--text-2)',
    background: active ? 'var(--live-dim)' : 'transparent',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

// Chevron glyph (›) shared by the "Projects" nav-row disclosure and each
// project row — a single glyph rotated 0→90deg, never swapped for a
// different up/down icon. Ported verbatim from the design's `chevStyle`
// strings (Nia Core App.html).
export function navChevronStyle(open: boolean): CSSProperties {
  return {
    flex: 'none',
    fontSize: 12,
    lineHeight: 1,
    color: 'var(--text-4)',
    transform: `rotate(${open ? 90 : 0}deg)`,
    transition: 'transform .16s ease',
  };
}

export function projectChevronStyle(open: boolean): CSSProperties {
  return {
    flex: 'none',
    fontSize: 11,
    lineHeight: 1,
    color: 'var(--nx-ink-3)',
    transform: `rotate(${open ? 90 : 0}deg)`,
    transition: 'transform .16s ease',
  };
}

// Shared label span for project/workflow tree rows — flex:1 + ellipsis
// truncation, matches the design's row-label span exactly.
export const treeLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// The project tree nested under the "Projects" parent row — no left
// padding here, indentation comes entirely from each row's own
// `padding-left` (Precision Dark redesign, Step 2, item b: 48px project
// rows, 60px workflow rows; "+ New project" bumped from 30 to 48 to stay
// under the project-row text start).
export const projectsNestStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  padding: '2px 0 6px',
};

export function projectRowStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px 6px 48px',
    borderRadius: 'var(--nx-radius)',
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--nx-raised)' : 'transparent',
    color: 'var(--nx-ink-2)',
    fontFamily: 'inherit',
    textAlign: 'left',
  };
}

export function workflowRowStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '6px 8px 6px 60px',
    borderRadius: 'var(--nx-radius)',
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--nx-raised)' : 'transparent',
    color: active ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
    fontSize: 13,
    fontFamily: 'inherit',
    textAlign: 'left',
  };
}

// "+ New project", last child of the tree. NOT role-gated: the design's
// own `isAdmin` guard here is driven by a hardcoded `get admin(){return
// true}` demo getter, not a real permission — and this app's actual RLS
// policy (see createProject in lib/dashboard/actions.ts) lets any org
// member create a project, not just admin/owner. Flagged for the user;
// left ungated to match this app's real capability model.
export const newProjectRowStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  padding: '7px 10px 7px 48px',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--nx-radius)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
};

export const sidebarFooterStyle: CSSProperties = {
  flex: 'none',
  borderTop: '1px solid var(--line)',
  padding: '10px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  position: 'relative',
};

export const topBarStyle: CSSProperties = {
  height: 52,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 16px',
  borderBottom: '1px solid var(--line)',
  background: 'var(--surface)',
};

export const brandMarkStyle: CSSProperties = {
  width: 24,
  height: 24,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 7,
  background: 'var(--live-fill)',
  color: 'var(--onacc)',
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1,
};

export const brandTextStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '-.02em',
  color: 'var(--text)',
};

export const breadcrumbSepStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-4)',
};

export const orgSwitcherBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--text-2)',
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

export const mainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};

export const homeScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '64px 56px 56px',
  display: 'flex',
  flexDirection: 'column',
  gap: 40,
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

// Precision Dark redesign (Step 3, Home): condensed-caps eyebrow above the
// greeting headline ("YOUR WORKSPACE").
export const nxGreetingTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

// Item 10: both headline lines (greeting + name) are Inter Tight
// 80px/76px, 500, -0.05em, --nx-ink — rendered as two separate `display:
// block` lines by HomeContent.tsx rather than one wrapping string.
export const greetingStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 80,
  fontWeight: 500,
  letterSpacing: '-0.05em',
  lineHeight: '76px',
  color: 'var(--nx-ink)',
};

// Item 11: the "N PROJECTS · N WORKFLOWS" counts, now pushed to the right
// end of the "Your workspace" eyebrow row instead of sitting under the
// headline.
export const greetingLineStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  letterSpacing: '0.02em',
  color: 'var(--nx-ink-3)',
};

export const continueCardStyle: CSSProperties = {
  width: 392,
  maxWidth: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '18px 20px 20px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  cursor: 'pointer',
};

// "Continue" label on the card — regular weight, sentence case.
export const continueLabelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 400,
  color: 'var(--text-3)',
};

export const cardTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text)',
};

export const cardMetaStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--text-3)',
};

export function statusDotStyle(status: 'running' | 'succeeded' | 'failed' | 'draft' | 'active' | 'paused'): CSSProperties {
  const color =
    status === 'running'
      ? 'var(--live)'
      : status === 'succeeded' || status === 'active'
        ? 'var(--ok)'
        : status === 'failed'
          ? 'var(--bad)'
          : status === 'paused'
            ? 'var(--warn)'
            : 'var(--text-4)';

  return {
    width: 7,
    height: 7,
    flex: 'none',
    borderRadius: '50%',
    background: color,
    animation: status === 'running' ? 'livePulse 1.4s ease-in-out infinite' : undefined,
  };
}

export const planBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '14px 18px',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-blue-tint)',
  border: '1px solid var(--nx-line)',
  color: 'var(--nx-ink)',
  fontSize: 13.5,
  fontFamily: 'var(--nx-font-ui)',
};

export const planBannerBtnStyle: CSSProperties = {
  flex: 'none',
  height: 34,
  padding: '0 16px',
  borderRadius: 'var(--nx-radius)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--nx-blue-cta-text)',
  background: 'var(--nx-blue-cta)',
  border: 'none',
  cursor: 'pointer',
};

export const runsSectionTitleStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 4,
};

export const runRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '11px 0',
  borderBottom: '1px solid var(--line)',
};

export function runStatusTextStyle(status: RunStatusLike): CSSProperties {
  return {
    fontSize: 12,
    color: status === 'failed' ? 'var(--bad)' : 'var(--text-3)',
  };
}

type RunStatusLike = 'running' | 'succeeded' | 'failed';

export const runMetaStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--text-3)',
};

export const emptyStateStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 6,
  padding: '28px 0',
  color: 'var(--text-3)',
  fontSize: 13,
};

// Simple sub-pages (Connections, Billing) that share the app shell but
// aren't the Home dashboard.
export const pageTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.7rem',
  fontWeight: 700,
  letterSpacing: '-.03em',
};

export const pageEmptyCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  padding: '32px 28px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  color: 'var(--text-3)',
  fontSize: 13.5,
  maxWidth: 460,
};

export const soonBtnStyle: CSSProperties = {
  height: 34,
  padding: '0 14px',
  borderRadius: 8,
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-4)',
  background: 'transparent',
  border: '1px solid var(--line)',
  cursor: 'default',
};

// Sidebar footer user row — avatar initials + email + role label, sits
// below the Settings row. Purely presentational (sign-out lives on the
// top bar avatar, matching the design). Icon-only rail centers just the
// avatar and drops the horizontal padding, same treatment as navItemStyle.
export function sidebarUserRowStyle(wide: boolean = true): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 8,
    padding: wide ? '8px 8px 2px' : '8px 0 2px',
  };
}

export const sidebarUserTextColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

export const sidebarUserEmailStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const sidebarUserRoleStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--text-3)',
  textTransform: 'capitalize',
};

// Top bar: search trigger ("Search or run" + ⌘K), notifications bell, and
// the avatar / sign-out button (26px circle, tooltip via title attr).
export const topBarSpacerStyle: CSSProperties = { flex: 1 };

export const topBarKbdStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
  lineHeight: 1,
};

export const topBarIconBtnStyle: CSSProperties = {
  position: 'relative',
  width: 30,
  height: 30,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--nx-radius)',
  background: 'transparent',
  border: 'none',
  color: 'var(--nx-ink-3)',
  fontSize: 15,
  cursor: 'pointer',
};

export const dropdownStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  minWidth: 220,
  boxSizing: 'border-box',
  padding: 6,
  borderRadius: 10,
  background: 'var(--raised, var(--surface))',
  border: '1px solid var(--line)',
  boxShadow: 'var(--drop)',
  zIndex: 40,
};

export const dropdownItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 32,
  boxSizing: 'border-box',
  padding: '0 8px',
  borderRadius: 7,
  fontSize: 13,
  color: 'var(--text)',
  background: 'transparent',
  border: 'none',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

// Settings menu opens upward since its trigger sits at the very bottom of
// the sidebar.
export const dropdownStyleUp: CSSProperties = {
  ...dropdownStyle,
  top: 'auto',
  bottom: 'calc(100% + 6px)',
};

export const settingsEmailRowStyle: CSSProperties = {
  ...dropdownItemStyle,
  cursor: 'default',
  color: 'var(--text-3)',
  height: 'auto',
  padding: '4px 8px 8px',
};

// Precision Dark redesign (Phase 2, UI-1): nx-themed variants of
// dropdownStyleUp/settingsEmailRowStyle above, used only by the Sidebar's
// Settings menu (now that it hosts the theme switcher). Kept separate
// rather than editing the two constants above, since those are shared with
// CanvasHeader/ProjectDetailClient/TopBar and must keep their current
// (non-nx) appearance everywhere else. Sharp corners (--nx-radius, 0px),
// 1px --nx-line border, same drop shadow as the shared dropdown.
export const nxDropdownStyleUp: CSSProperties = {
  ...dropdownStyleUp,
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const nxSettingsEmailRowStyle: CSSProperties = {
  ...settingsEmailRowStyle,
  color: 'var(--nx-ink-3)',
};

// ---------------------------------------------------------------------
// Precision Dark redesign (Step 2): Sidebar + TopBar restyle. Where a
// style object above is also used by CanvasHeader.tsx (topBarStyle,
// orgSwitcherBtnStyle, dropdownStyle/dropdownItemStyle, breadcrumbSepStyle,
// pageCrumbLinkStyle/pageCrumbCurrentStyle) a fresh nx-prefixed copy is
// defined here instead, so CanvasHeader/the canvas route are completely
// unaffected. TopBar-exclusive styles (topBarKbdStyle,
// topBarSearchBtnStyle, topBarIconBtnStyle, topBarAvatarBtnStyle,
// profileEmailTextStyle) and Sidebar-exclusive styles (navGroupLabelStyle,
// treeLabelStyle, projectsNestStyle, projectRowStyle, workflowRowStyle,
// projectChevronStyle, newProjectRowStyle) are instead edited in place,
// further up this file. The old canvas/styles.ts `iconRail*` rail-layout
// functions (Sidebar-exclusive, but living in the canvas folder as a
// leftover from an earlier consolidation — see Sidebar.tsx's top comment)
// are left untouched; the functions below replace them for Sidebar.tsx.
// ---------------------------------------------------------------------

// Row color/background now comes from the .nx-wipe/.nx-active-cell/
// .nx-row-disabled CSS classes (theme.css) instead of inline styles, since
// plain CSSProperties can't express :hover/:focus-visible — these
// functions are layout-only (size/spacing/radius).
export function navRailStyle(width: number, dragging: boolean, wide: boolean): CSSProperties {
  return {
    flex: 'none',
    width,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: wide ? 'stretch' : 'center',
    background: 'var(--nx-bg)',
    borderRight: '1px solid var(--nx-line)',
    boxSizing: 'border-box',
    position: 'relative',
    transition: dragging ? 'none' : 'width 450ms var(--nx-ease)',
  };
}

export function navRailHandleStyle(dragging: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -3,
    width: 7,
    zIndex: 12,
    cursor: 'col-resize',
    background: dragging ? 'var(--nx-blue-panel)' : 'transparent',
    opacity: dragging ? 0.5 : 1,
    transition: 'background 120ms var(--nx-ease)',
  };
}

// Logo header cell — height matches whichever header sits beside the rail
// (64px under AppShell/TopBar, 52px on the canvas route next to
// CanvasHeader; Sidebar.tsx takes this as a `headerHeight` prop, default
// 64). Bottom border lines up with the header it sits beside.
export function navRailHeaderStyle(wide: boolean, headerHeight: number): CSSProperties {
  return {
    flex: 'none',
    height: headerHeight,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 10,
    padding: wide ? '0 16px' : 0,
    borderBottom: '1px solid var(--nx-line)',
  };
}

export const navWordmarkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export function navRailScrollStyle(wide: boolean): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: wide ? 'stretch' : 'center',
    overflowY: 'auto',
    width: '100%',
    // Full-bleed rows (item 7): no horizontal inset while wide — rows go
    // edge to edge and rely on their own bottom divider (navRailBtnStyle's
    // borderBottom) for separation instead of a gap between rows.
    padding: wide ? '12px 0' : '12px 0',
    gap: wide ? 0 : 2,
    boxSizing: 'border-box',
  };
}

export function navRailFooterStyle(): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: 8,
    borderTop: '1px solid var(--nx-line)',
    width: '100%',
    boxSizing: 'border-box',
    position: 'relative',
  };
}

// Nav row layout (Home, Projects, Connections, Billing, Settings, etc.) —
// pair with className="nx-wipe" (+ "nx-active-cell" when active, or
// "nx-row-disabled" when disabled) for color/hover/focus.
export function navRailBtnStyle(wide: boolean): CSSProperties {
  return {
    flex: 'none',
    width: wide ? '100%' : 36,
    // Full-bleed rows (item 7): 44px tall, edge to edge, no gap between
    // rows — separation comes from the bottom divider below instead.
    height: wide ? 44 : 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 10,
    borderRadius: 'var(--nx-radius)',
    fontSize: 13.5,
    border: 'none',
    borderBottom: wide ? '1px solid var(--nx-line-inner)' : 'none',
    cursor: 'pointer',
    marginBottom: wide ? 0 : 2,
    padding: wide ? '0 10px' : 0,
    textDecoration: 'none',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  };
}

export const navRailBtnLabelStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Right-aligned "SOON" meta badge for disabled nav rows (Org dashboard,
// Runs, Audit log) — the row label itself now shows only the plain name;
// this carries the "— soon" context visually instead of baking it into
// the label text. `margin-left: auto` pushes it flush right inside the
// row's flex layout regardless of label width. Screen readers still get
// the full "<Label> — soon" context via the row's aria-label/title.
export const navRailSoonMetaStyle: CSSProperties = {
  marginLeft: 'auto',
  flex: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--nx-ink-disabled)',
};

export const navRailExpandToggleStyle: CSSProperties = {
  flex: 'none',
  width: '100%',
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: 'none',
  background: 'none',
  borderRadius: 'var(--nx-radius)',
  cursor: 'pointer',
  fontSize: 12.5,
  marginTop: 4,
  fontFamily: 'inherit',
};

// Sidebar tree status dot — workflow LIFECYCLE (active/paused/draft), not
// RUN status (running/succeeded/failed), which stays on the existing
// `statusDotStyle` above (shared with ProjectDetailClient.tsx, reserved
// for future RunStatus pages e.g. Home run history). 6px square: active/
// paused are solid fills, draft is a hollow 1px-bordered square.
// `onActiveCell` is true when the row itself has the solid --nx-ink
// active background — flips draft's border to --nx-bg so it doesn't
// disappear against the dark cell; active/paused fills are unchanged
// there.
export function navTreeStatusDotStyle(
  status: 'active' | 'paused' | 'draft',
  onActiveCell: boolean = false,
): CSSProperties {
  if (status === 'draft') {
    return {
      width: 6,
      height: 6,
      flex: 'none',
      boxSizing: 'border-box',
      border: `1px solid ${onActiveCell ? 'var(--nx-bg)' : 'var(--nx-ink-3)'}`,
      background: 'transparent',
    };
  }
  return {
    width: 6,
    height: 6,
    flex: 'none',
    background: status === 'active' ? 'var(--nx-blue-panel)' : 'var(--nx-warn)',
  };
}

export function navTreeStatusLabel(status: 'active' | 'paused' | 'draft'): string {
  return status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Draft';
}

// nx-themed TopBar — height 64 (was 52). Left untouched: topBarStyle
// itself (CanvasHeader.tsx still uses the old 52px version unchanged).
// Row itself carries no padding/gap any more — every child renders as its
// own full-height bordered "cell" (logo/org switcher/breadcrumbs/search/
// notifications/avatar), so spacing lives on the cells, not the row.
export const nxTopBarStyle: CSSProperties = {
  height: 64,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'stretch',
  borderBottom: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
};

// Logo cell — first cell in the TopBar row. Width tracks the sidebar's
// live railW (Zustand store, read-only in TopBar.tsx) so its right border
// continues the sidebar's right edge in one straight line. `overflow:
// hidden` clips the wordmark cleanly while the cell narrows during drag.
export function nxTopBarLogoCellStyle(width: number): CSSProperties {
  return {
    flex: 'none',
    width,
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 16px',
    overflow: 'hidden',
    borderRight: '1px solid var(--nx-line)',
  };
}

// Generic bordered TopBar cell (org switcher / breadcrumbs / search /
// notifications / avatar) — full height, 16px horizontal padding, right
// divider. Pair with className="nx-wipe" for the hover background wipe.
// `bordered=false` drops the right divider for the row's last cell.
export function nxTopBarCellStyle(bordered: boolean = true): CSSProperties {
  return {
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 20px',
    borderRight: bordered ? '1px solid var(--nx-line)' : 'none',
  };
}

export const nxOrgSwitcherBtnStyle: CSSProperties = {
  ...orgSwitcherBtnStyle,
  fontSize: 15,
  color: 'var(--nx-ink-2)',
};

// Search cell (item 2 of the fix pass): a plain 280px cell with a single
// left divider — no inner boxed input, no bordered kbd chip. Pair with
// className="nx-wipe" on the outer cell for the hover background.
export const nxTopBarSearchCellStyle: CSSProperties = {
  flex: 'none',
  width: 280,
  height: '100%',
  boxSizing: 'border-box',
  padding: '0 20px',
  borderLeft: '1px solid var(--nx-line)',
};

// The button fills the whole search cell so the entire 280px width (not
// just the text) opens the palette.
export const topBarSearchBtnFillStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  height: '100%',
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--nx-ink-3)',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

export const topBarSearchLabelStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--nx-ink-3)',
};

// 64px square cell shared by the bell and avatar — left border only (the
// row's own right border, if any, comes from whichever cell sits to its
// right).
export function topBarSquareCellStyle(withLeftBorder: boolean = true): CSSProperties {
  return {
    flex: 'none',
    width: 64,
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeft: withLeftBorder ? '1px solid var(--nx-line)' : 'none',
  };
}

export const topBarInitialsStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  color: 'var(--nx-ink)',
};

export const nxDropdownStyle: CSSProperties = {
  ...dropdownStyle,
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const nxDropdownItemStyle: CSSProperties = {
  ...dropdownItemStyle,
  borderRadius: 'var(--nx-radius)',
  color: 'var(--nx-ink)',
};

// Breadcrumbs (item f): mono 12px --nx-ink-3 links, "/" separators in
// --nx-line, last (current) crumb in --nx-ink.
export const nxBreadcrumbSepStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-line)',
};

export const nxPageCrumbLinkStyle: CSSProperties = {
  padding: 0,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
};

export const nxPageCrumbCurrentStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink)',
};

// Top bar profile dropdown (avatar → email + Sign out) — the header-right
// counterpart to the old sidebar-footer sign-out row.
export const profileEmailRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px 8px',
};

export const profileEmailTextStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Modal / dialog shared with create-project and create-workflow
export const modalOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(5, 9, 16, .5)',
};

export const modalCardStyle: CSSProperties = {
  width: 380,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  padding: '22px 22px 20px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  boxShadow: 'var(--shadow)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const modalTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--text)',
};

export const modalLabelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--text)' };

export function modalFieldStyle(hasError: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    height: 40,
    padding: '0 12px',
    fontFamily: 'inherit',
    fontSize: 14,
    color: 'var(--text)',
    background: 'var(--surface2)',
    border: `1px solid ${hasError ? 'var(--bad)' : 'var(--line)'}`,
    borderRadius: 9,
    outline: 'none',
  };
}

export const modalErrorStyle: CSSProperties = { fontSize: 12.5, color: 'var(--bad)' };

export const modalActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 4,
};

export const modalBtnGhostStyle: CSSProperties = {
  height: 36,
  padding: '0 14px',
  borderRadius: 8,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--text-2)',
  background: 'transparent',
  border: '1px solid var(--line)',
  cursor: 'pointer',
};

export const modalBtnPrimaryStyle: CSSProperties = {
  height: 36,
  padding: '0 14px',
  borderRadius: 8,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--onacc)',
  background: 'var(--live-fill)',
  border: 'none',
  cursor: 'pointer',
};

// Precision Dark redesign (Step 3, Home): nx-token restyle of the dialog
// shell used by CreateProjectDialog/CreateWorkflowDialog. A parallel set
// rather than edits to modal*Style above, since those are still used
// as-is by AddConnectionDialog/ConnectionForm/CommandPalette.
export const nxModalOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'color-mix(in srgb, var(--nx-bg) 78%, transparent)',
};

export const nxModalCardStyle: CSSProperties = {
  width: 400,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-bg)',
  display: 'flex',
  flexDirection: 'column',
};

export const nxModalBodyStyle: CSSProperties = {
  padding: '24px 24px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const nxModalTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxModalTitleStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: '-0.035em',
  color: 'var(--nx-ink)',
};

export const nxModalLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 11.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export function nxModalFieldStyle(hasError: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    height: 40,
    padding: '0 12px',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 14,
    color: 'var(--nx-ink)',
    background: 'var(--nx-surface)',
    border: `1px solid ${hasError ? 'var(--nx-danger)' : 'var(--nx-line)'}`,
    borderRadius: 'var(--nx-radius)',
    outline: 'none',
  };
}

export const nxModalErrorStyle: CSSProperties = { fontSize: 12.5, color: 'var(--nx-danger-text)' };

// Footer: 52px row, a 120px "CANCEL" cell with a right divider, primary
// action filling the rest — per the Step 3 dialog spec.
export const nxModalFooterStyle: CSSProperties = {
  display: 'flex',
  height: 52,
  borderTop: '1px solid var(--nx-line)',
};

export const nxModalCancelCellStyle: CSSProperties = {
  width: 120,
  flex: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--nx-line)',
  cursor: 'pointer',
};

export function nxModalPrimaryCellStyle(pending: boolean): CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 13.5,
    fontWeight: 600,
    color: pending ? 'var(--nx-blue-soft-text)' : 'var(--nx-blue-cta-text)',
    background: pending ? 'var(--nx-blue-tint)' : 'var(--nx-blue-cta)',
    border: 'none',
    cursor: pending ? 'default' : 'pointer',
  };
}

export const modalBtnDangerStyle: CSSProperties = {
  height: 36,
  padding: '0 14px',
  borderRadius: 8,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: '#fff',
  background: 'var(--bad)',
  border: 'none',
  cursor: 'pointer',
};

// Content region for pages nested one level under a nav item (project
// detail today) — ported verbatim from the design's `isProject` content
// div: padding:44px 56px 56px;gap:30px. Deliberately distinct from
// homeScrollStyle's 64px/gap:40 (Home's own content div uses different
// values in the design — they are not the same style).
export const projectScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '44px 56px 56px',
  display: 'flex',
  flexDirection: 'column',
  gap: 30,
};

// A primary (indigo/--live-fill) action button — mirrors the design's
// `primary(on)` factory in App.html exactly (height 32, 12.5px/500,
// radius 9, no border). Used for "New workflow"/"New project"-type CTAs
// in page content (not the sidebar's own dark "+ New workflow" button,
// which the design deliberately keeps ink-colored, not indigo).
export const primaryBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  borderRadius: 9,
  border: 'none',
  background: 'var(--live-fill)',
  color: 'var(--onacc)',
  cursor: 'pointer',
};

// Page-path breadcrumb pieces — rendered by the shared TopBar (see its
// `crumbs` prop), not by individual pages, so there's only ever one path
// shown, in the header.
export const pageCrumbLinkStyle: CSSProperties = {
  padding: 0,
  fontSize: 13,
  color: 'var(--text-3)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textDecoration: 'none',
};

export const pageCrumbCurrentStyle: CSSProperties = { color: 'var(--text-2)' };

// Header row below the breadcrumb: project name (display type) + meta
// line on the left, primary "New workflow" action + kebab menu on the
// right — replaces the old full-width grey "Workflows" pill header.
export const projectHeaderRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 20,
};

export const projectTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
};

export const projectTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.72rem',
  fontWeight: 700,
  letterSpacing: '-.032em',
  lineHeight: 1.1,
};

export const projectMetaStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-3)',
};

export const kebabBtnStyle: CSSProperties = {
  width: 30,
  height: 30,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  background: 'transparent',
  border: '1px solid var(--line)',
  color: 'var(--text-3)',
  fontSize: 16,
  cursor: 'pointer',
};

// Compact single-line row, ported from the design's `projectFlows` row
// (dot + name + status label + right-aligned timestamp, 1px bottom
// border) — not a padded/rounded card like the previous implementation.
export const workflowListRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 0',
  borderBottom: '1px solid var(--line)',
  textDecoration: 'none',
  color: 'inherit',
};

export const workflowListNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const workflowListStatusStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-3)',
  textTransform: 'capitalize',
};

export const workflowListMetaStyle: CSSProperties = {
  marginLeft: 'auto',
  flex: 'none',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--text-3)',
};

// Projects list page (/app/projects) — ported from the design's `isProjects`
// section: full-width rows (name+count / last-activity / delete), separated
// by a 1px bottom border, negative side margin so the border/hover box
// bleeds to the row's own padding rather than the page's. No card wrapping.
export const projectListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 900,
};

export const projectListRowStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '16px 12px',
  margin: '0 -12px',
  borderBottom: '1px solid var(--line)',
  borderRadius: 10,
  background: 'transparent',
  textDecoration: 'none',
  color: 'inherit',
};

export const projectListNameColStyle: CSSProperties = {
  flex: 2,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  textAlign: 'left',
};

export const projectListNameStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const projectListCountStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-3)',
};

export const projectListActivityStyle: CSSProperties = {
  flex: 1,
  fontSize: 12,
  color: 'var(--text-3)',
  textAlign: 'left',
};

// Design's `deleteStyle` — flex:none;height:26px;padding:0 10px;font-size:
// 12px;radius:6px;transparent bg;1px --line2 border;--ink3 text. Ported 1:1
// (--line2/--ink3 alias to --line-strong/--text-3 in this app's token layer).
export const projectListDeleteBtnStyle: CSSProperties = {
  flex: 'none',
  height: 26,
  boxSizing: 'border-box',
  padding: '0 10px',
  fontSize: 12,
  borderRadius: 6,
  background: 'transparent',
  border: '1px solid var(--line-strong)',
  color: 'var(--text-3)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export const projectListEmptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 18,
  padding: '120px 20px',
};

export const projectListEmptyTextStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.05rem',
  fontWeight: 650,
  letterSpacing: '-.02em',
  color: 'var(--text-2)',
  textAlign: 'center',
};

// Connections page (/app/connections) — ported from the design's
// `isConnections` section. No connections/connectors table exists yet
// (packages/schemas/src/{contract,jobs,manifest,tabular}.ts only define the
// connector *protocol*), so this page renders hardcoded sample data with
// "coming soon" disabled actions until real connector wiring lands.

export type ConnectionHealth = 'ok' | 'idle' | 'error';
export type ConnectorCategory = 'databases' | 'warehouses' | 'bi' | 'ai-vector' | 'files';

// Category colors extracted directly from the design's rendered DOM
// (--c-data/--c-action/--c-condition already exist as canvas node-kind
// tokens in theme.css and happen to be reused here verbatim by the design;
// AI vector's dot is exactly --text-4; BI's sky-500 has no existing token
// so a new --info was added to theme.css alongside --ok/--bad/--warn).
export function categoryDotColor(category: ConnectorCategory): string {
  switch (category) {
    case 'databases':
      return 'var(--c-data)';
    case 'warehouses':
      return 'var(--c-action)';
    case 'bi':
      return 'var(--info)';
    case 'ai-vector':
      return 'var(--text-4)';
    case 'files':
      return 'var(--c-condition)';
  }
}

export function healthDotColor(health: ConnectionHealth): string {
  return health === 'ok' ? 'var(--ok)' : health === 'error' ? 'var(--bad)' : 'var(--warn)';
}

export const connectionsSubtitleStyle: CSSProperties = {
  fontSize: 13.5,
  color: '#6B6E76',
};

export const connectionsHealthStripStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12.5,
  color: 'var(--text-3)',
};

export const connectionsHealthDotsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

export function connectionsHealthDotStyle(health: ConnectionHealth): CSSProperties {
  return {
    width: 6,
    height: 6,
    flex: 'none',
    borderRadius: '50%',
    background: healthDotColor(health),
  };
}

// Round 5 — the app has no CSS --radius token scale (every radius in the
// app is a hardcoded px number inline; nearest existing values are 14 for
// cards/dialogs, 9 for primary buttons, 8 for dialog secondary buttons,
// 10 for dropdowns). These are page-scoped values reused/added for the
// Connections page only: `container` (12) has no existing app-wide
// equivalent (between the 10 dropdown token and the 14 card token); the
// rest reuse or exactly match existing app values.
export const CONNECTIONS_RADIUS = {
  card: 16, // connector card shell
  container: 12, // installed list, connections table, empty-state panel
  control: 10, // search input, segmented-control container, dropdown/menu shells, ~40px buttons
  chip: 8, // segments, docs icon button, small 28-32px buttons, icon tiles
  tag: 6, // status badges, menu items
} as const;

// Single consolidated row — search + category segmented control + Works-as
// segmented control all share this row now (previously Works-as was a
// separate full-width row below); wraps under ~1100px.
export const connectionsToolbarRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

export const connectionsSearchBoxStyle: CSSProperties = {
  flex: 1,
  minWidth: 200,
  maxWidth: 320,
  height: 36,
  boxSizing: 'border-box',
  padding: '0 14px',
  borderRadius: CONNECTIONS_RADIUS.control,
  border: '1px solid #DEDEE3',
  background: '#FFFFFF',
  color: '#0E0E12',
  fontFamily: 'inherit',
  fontSize: 13,
  outline: 'none',
};

export const connectionsFilterListStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: 'none',
  padding: 4,
  borderRadius: CONNECTIONS_RADIUS.control,
  background: '#FFFFFF',
  border: '1px solid #DEDEE3',
};

export function connectionsFilterPillStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 30,
    boxSizing: 'border-box',
    padding: '0 13px',
    borderRadius: CONNECTIONS_RADIUS.chip,
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: active ? '#0E0E12' : 'transparent',
    color: active ? '#FFFFFF' : '#52555C',
  };
}

export const connectionsSectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
};

export const connectionsSectionTitleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: '#0E0E12',
};

export const connectionsSectionMetaStyle: CSSProperties = {
  fontSize: 12.5,
  color: '#6B6E76',
};

export const connectionsProviderListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: CONNECTIONS_RADIUS.container,
  background: '#FFFFFF',
  border: '1px solid #E4E4E8',
  overflow: 'hidden',
};

// 56px total row height: 12px top+bottom padding around a 32px icon tile.
export function connectionsProviderRowStyle(bordered: boolean, dashed = false): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '12px 16px',
    borderBottom: bordered ? `1px ${dashed ? 'dashed' : 'solid'} #ECECEF` : 'none',
  };
}

// The Upload CSV/Excel row is visually distinct: a dashed top divider,
// square corners throughout.
export const connectionsUploadRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
  padding: '12px 16px',
  borderTop: '1px dashed #ECECEF',
  background: '#FAFAFB',
};

export const connectionsUploadIconStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: CONNECTIONS_RADIUS.chip,
  fontSize: 14,
  background: '#FFFFFF',
  border: '1px solid #E4E4E8',
  color: '#6B6E76',
};

export const connectionsUploadBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  color: '#6B6E76',
  background: '#FFFFFF',
  border: '1px solid #DEDEE3',
  borderRadius: CONNECTIONS_RADIUS.chip,
  cursor: 'not-allowed',
  whiteSpace: 'nowrap',
};

export const connectionsProviderNameColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 150,
  flex: 'none',
};

export const connectionsProviderNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: '#0E0E12',
};

export const connectionsProviderMetaStyle: CSSProperties = {
  fontSize: 12.5,
  color: '#6B6E76',
};

export const connectionsBadgesRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  flex: 1,
};

export function connectionsBadgeStyle(health: ConnectionHealth): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 26,
    boxSizing: 'border-box',
    padding: '0 10px',
    borderRadius: CONNECTIONS_RADIUS.tag,
    fontSize: 12,
    background: health === 'error' ? 'var(--bad-bg)' : 'var(--surface2)',
    border: health === 'error' ? '1px solid var(--bad-bd)' : '1px solid transparent',
    color: 'var(--text-2)',
  };
}

export function connectionsBadgeDotStyle(health: ConnectionHealth): CSSProperties {
  return {
    width: 6,
    height: 6,
    flex: 'none',
    borderRadius: '50%',
    background: healthDotColor(health),
  };
}

export const connectionsBadgeHandleStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--text)',
};

export const connectionsBadgeMetaStyle: CSSProperties = {
  color: '#6B6E76',
};

export const connectionsBadgeLinkStyle: CSSProperties = {
  color: 'var(--live)',
  fontWeight: 600,
  textDecoration: 'underline',
  cursor: 'default',
};

export const connectionsProviderActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 'none',
  marginLeft: 'auto',
};

// Installed row's standalone "Uninstall" button — destructive (white bg,
// red border/text), 32px tall, next to the ⋯ menu.
export const connectionsDangerBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 12px',
  borderRadius: CONNECTIONS_RADIUS.chip,
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--bad)',
  background: '#FFFFFF',
  border: '1px solid var(--bad)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

// v4 card grid (CARD.height=472). Column count follows the spec's fixed
// breakpoint table against the catalog section's own *content* width (not
// the viewport — the sidebar rail is user-resizable, so a viewport media
// query would drift): 3 columns by default (>= 860px), 2 from 540-859px,
// 1 below 540px. Implemented as CSS container-query rules (see the
// `.nia-connector-grid` / `.nia-connector-catalog` selectors rendered
// alongside the grid in ConnectionsClient.tsx). gridTemplateColumns is
// deliberately NOT set here — an inline style always wins over any
// stylesheet rule (including one inside an `@container` block), so the
// 1-column default and every breakpoint override both live in the CSS
// class rules instead, not in this inline style object.
export const connectionsAvailableGridStyle: CSSProperties = {
  display: 'grid',
  gap: 24,
  alignItems: 'start',
};

// Step 2 (page layout redesign) — header, "Your connections" table and
// catalog toolbar additions. Connector-card internals (Step 3) keep using
// the styles below this block unchanged.

export const connectionsPageHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 24,
  flexWrap: 'wrap',
};

export const connectionsHeaderButtonsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flex: 'none',
};

// "Request a connector" has no backend action yet (no request-a-connector
// endpoint/table exists) — rendered inert like the Upload CSV button above,
// not wired to an invented action.
export const connectionsRequestBtnStyle: CSSProperties = {
  height: 36,
  boxSizing: 'border-box',
  padding: '0 16px',
  borderRadius: CONNECTIONS_RADIUS.chip,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: '#6B6E76',
  background: '#FFFFFF',
  border: '1px solid #DEDEE3',
  cursor: 'not-allowed',
  whiteSpace: 'nowrap',
};

export const connectionsHealthFilterRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  flexWrap: 'wrap',
};

export function connectionsHealthFilterBtnStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 11px',
    borderRadius: CONNECTIONS_RADIUS.chip,
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    border: active ? '1px solid #0E0E12' : '1px solid #DEDEE3',
    background: active ? '#0E0E12' : '#FFFFFF',
    color: active ? '#FFFFFF' : '#52555C',
  };
}

// overflow:hidden removed — it was clipping the row "⋯" menu; the menu
// itself is portaled to document.body, which independently escapes any
// ancestor's overflow/stacking context.
export const connectionsTableCardStyle: CSSProperties = {
  borderRadius: CONNECTIONS_RADIUS.container,
  border: '1px solid #E4E4E8',
  background: '#FFFFFF',
  overflowX: 'auto',
};

export const connectionsTableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

export const connectionsTableHeadRowStyle: CSSProperties = {
  borderBottom: '1px solid #E4E4E8',
};

// Header uses the app's default UI font (var(--font-ui), inherited — no
// override), same small-uppercase-label treatment as navGroupLabelStyle.
export const connectionsTableThStyle: CSSProperties = {
  textAlign: 'left',
  padding: '10px 16px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: '#8A8D94',
  whiteSpace: 'nowrap',
};

export const connectionsTableRowStyle: CSSProperties = {
  borderBottom: '1px solid #ECECEF',
};

export const connectionsTableTdStyle: CSSProperties = {
  padding: '14px 16px',
  verticalAlign: 'middle',
  fontSize: 13,
  color: '#52555C',
};

export const connectionsTableConnCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

export const connectionsTableTileStyle: CSSProperties = {
  width: 36,
  height: 36,
  flex: 'none',
  borderRadius: CONNECTIONS_RADIUS.chip,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#fff',
  border: '1px solid #E4E4E8',
};

export const connectionsTableHostStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: '#52555C',
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  display: 'block',
};

export const connectionsTableActionsCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  position: 'relative',
};

export const connectionsTableMenuBtnStyle: CSSProperties = {
  width: 28,
  height: 28,
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: CONNECTIONS_RADIUS.chip,
  border: '1px solid #DEDEE3',
  background: '#FFFFFF',
  color: '#6B6E76',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
};

// Portaled to document.body (ConnectionsClient's RowMenu) — top/left are
// computed per-open from the trigger button's getBoundingClientRect(), so
// this base style only sets shape/chrome, not position.
export const connectionsTableMenuStyle: CSSProperties = {
  position: 'fixed',
  minWidth: 160,
  background: '#FFFFFF',
  border: '1px solid #DEDEE3',
  borderRadius: CONNECTIONS_RADIUS.control,
  boxShadow: '0 8px 24px rgba(14,14,18,.14)',
  padding: 4,
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
};

export const connectionsTableMenuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  borderRadius: CONNECTIONS_RADIUS.tag,
  border: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  color: '#0E0E12',
  cursor: 'pointer',
};

export const connectionsCatalogHintStyle: CSSProperties = {
  textAlign: 'center',
  fontSize: 12.5,
  color: '#6B6E76',
};

export const connectionsEmptyPanelStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, .9fr)',
  gap: 32,
  padding: 28,
  borderRadius: CONNECTIONS_RADIUS.container,
  border: '1px solid #E4E4E8',
  background: '#FFFFFF',
};

export const connectionsEmptyStepsColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};

export const connectionsEmptyStepStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
};

export const connectionsEmptyStepNumStyle: CSSProperties = {
  width: 24,
  height: 24,
  flex: 'none',
  borderRadius: '50%',
  background: 'var(--surface2)',
  color: 'var(--text-2)',
  fontSize: 12,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const connectionsEmptySuggestColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

// Connector card v4 — 472px card with a rest view (name/kind/description/
// facts below a 220px media band) and a hover/focus view (card turns
// #0A0A0B, logo glides to a small top-left mark, a single bottom-anchored
// dark text block replaces the rest text). Both views stay mounted at all
// times — only opacity/position/pointer-events toggle — and the footer
// never fades, it just recolors, so it can't ever flash. Ported 1:1 from
// designs/Connections — with connections-html/Connections.dc.html's
// `cardBuilder` (same pixel values, same cubic-bezier(.2,.8,.2,1) easing).
const CARD_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export const CARD = {
  height: 472,
  media: 220,
  logoRest: 108,
  logoHover: 56,
  imgRest: 76,
  imgHover: 32,
  textTop: 242, // media (220) + 22
  darkBottom: 92,
  footerBottom: 24,
  footerHeight: 44,
  docsBtnSize: 44,
} as const;

function cardT(prop: string, duration: number, delayMs = 0): string {
  return `${prop} ${duration}ms ${CARD_EASE}${delayMs ? ` ${delayMs}ms` : ''}`;
}

// Outer 472px shell — background/border/shadow invert and the card lifts
// 4px on hover/focus. `comingSoon` dims the rest view to 75% opacity
// (matches the reference's `c.soon && !on` rule) so a disabled card still
// reads as part of the grid, not broken.
export function connectorCardShellStyle(active: boolean, comingSoon: boolean, reducedMotion: boolean): CSSProperties {
  return {
    position: 'relative',
    boxSizing: 'border-box',
    width: '100%',
    height: CARD.height,
    overflow: 'hidden',
    cursor: 'pointer',
    borderRadius: CONNECTIONS_RADIUS.card,
    background: active ? '#0A0A0B' : '#FFFFFF',
    border: `1px solid ${active ? '#0A0A0B' : '#E4E4E8'}`,
    boxShadow: active ? '0 20px 40px rgba(14,14,18,.22)' : '0 1px 0 rgba(14,14,18,.03)',
    transform: !reducedMotion && active ? 'translateY(-4px)' : 'translateY(0)',
    opacity: comingSoon && !active ? 0.75 : 1,
    transition: reducedMotion
      ? [cardT('background-color', 120), cardT('border-color', 120), cardT('box-shadow', 120)].join(', ')
      : [cardT('background-color', 360), cardT('border-color', 360), cardT('box-shadow', 360), cardT('transform', 360)].join(', '),
  };
}

// Top media band — plain #FAFAFB fill with a hairline bottom border at
// rest; both disappear (transparent) on hover so the card reads as one
// solid dark surface.
export function connectorMediaStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: CARD.media,
    // Nested-radius rule: the card's top corners are CONNECTIONS_RADIUS.card
    // (16); this band sits flush against them, so its own top corners are
    // 16 - 1 (the card's border width) = 15. Its bottom corners are square
    // since it ends mid-card. The card's own overflow:hidden already clips
    // this to the rounded shape, but the radius is set explicitly too so it
    // matches on inspection.
    borderRadius: `${CONNECTIONS_RADIUS.card - 1}px ${CONNECTIONS_RADIUS.card - 1}px 0 0`,
    background: active ? 'transparent' : '#FAFAFB',
    borderBottom: `1px solid ${active ? 'transparent' : '#EFEFF2'}`,
    transition: reducedMotion ? cardT('background-color', 120) : [cardT('background-color', 360), cardT('border-color', 360)].join(', '),
  };
}

export function connectorCategoryLabelStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 20,
    top: 20,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    color: '#8A8D94',
    opacity: active ? 0 : 1,
    transition: reducedMotion ? cardT('opacity', 120) : cardT('opacity', 160),
  };
}

export type ConnectorBadgeKind = 'connected' | 'soon';

export function connectorTopBadgeStyle(active: boolean, kind: ConnectorBadgeKind, reducedMotion: boolean): CSSProperties {
  const inkColor = kind === 'connected' ? '#17803D' : '#6B6E76';
  return {
    position: 'absolute',
    right: 20,
    top: 20,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    boxSizing: 'border-box',
    padding: '0 8px',
    borderRadius: CONNECTIONS_RADIUS.tag,
    border: `1px solid ${active ? 'rgba(255,255,255,.25)' : '#E4E4E8'}`,
    background: active ? 'transparent' : '#FFFFFF',
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: active ? '#FFFFFF' : inkColor,
    transition: reducedMotion
      ? cardT('color', 120)
      : [cardT('border-color', 360), cardT('background-color', 360), cardT('color', 360)].join(', '),
  };
}

export function connectorBadgeDotStyle(kind: ConnectorBadgeKind): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: kind === 'connected' ? '#1F9D4C' : '#A9ABB2',
  };
}

// Logo box — glides from a centered 160px box (128px mark) to a top-left
// 76px box (48px mark) on hover. No background/border in either state —
// the brand mark (or initials fallback) sits directly on the card.
export function connectorLogoBoxStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  const size = active ? CARD.logoHover : CARD.logoRest;
  return {
    position: 'absolute',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    borderRadius: 0,
    background: 'transparent',
    left: active ? 20 : 'calc(50% - 54px)',
    top: active ? 20 : (CARD.media - CARD.logoRest) / 2,
    width: size,
    height: size,
    border: 0,
    transition: reducedMotion
      ? cardT('opacity', 120)
      : [cardT('left', 440), cardT('top', 440), cardT('width', 440), cardT('height', 440)].join(', '),
  };
}

export function connectorLogoImgStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  const size = active ? CARD.imgHover : CARD.imgRest;
  return {
    width: size,
    height: size,
    objectFit: 'contain',
    transition: reducedMotion ? cardT('opacity', 120) : [cardT('width', 440), cardT('height', 440)].join(', '),
  };
}

export function connectorLogoMonoStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    fontSize: active ? 16 : 31,
    fontWeight: 600,
    letterSpacing: '-.02em',
    color: active ? '#FFFFFF' : '#0E0E12',
    transition: reducedMotion ? cardT('opacity', 120) : [cardT('font-size', 440), cardT('color', 440)].join(', '),
  };
}

// Rest-view text block (name/kind/description/facts) — fades out and
// drops 8px on hover so the dark block underneath reads as the active
// state.
export function connectorRestTextStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 24,
    right: 24,
    top: CARD.textTop,
    display: 'flex',
    flexDirection: 'column',
    opacity: active ? 0 : 1,
    transform: !reducedMotion && active ? 'translateY(8px)' : 'translateY(0)',
    pointerEvents: active ? 'none' : 'auto',
    transition: reducedMotion ? cardT('opacity', 120) : [cardT('opacity', 160), cardT('transform', 260)].join(', '),
  };
}

export const connectorNameStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  lineHeight: '28px',
  fontWeight: 500,
  letterSpacing: '-.015em',
  color: '#0E0E12',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const connectorSubtitleStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: '20px',
  color: '#6B6E76',
  marginTop: 2,
};

export const connectorDescStyle: CSSProperties = {
  margin: '10px 0 0',
  fontSize: 14,
  lineHeight: '21px',
  color: '#52555C',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

// Footer (main button + Docs button) — always visible, never fades; only
// its colors change between rest and hover/focus.
export const connectorFooterStyle: CSSProperties = {
  position: 'absolute',
  left: 24,
  right: 24,
  bottom: CARD.footerBottom,
  display: 'flex',
  gap: 8,
};

export type ConnectorMainButtonKind = 'install' | 'uninstall' | 'notify';

export function connectorMainButtonStyle(kind: ConnectorMainButtonKind, active: boolean, reducedMotion: boolean): CSSProperties {
  const base: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    height: CARD.footerHeight,
    boxSizing: 'border-box',
    padding: '0 16px',
    borderRadius: CONNECTIONS_RADIUS.control,
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    transition: reducedMotion
      ? cardT('color', 120)
      : [cardT('background-color', 360), cardT('color', 360), cardT('border-color', 360)].join(', '),
  };
  if (kind === 'notify') {
    return {
      ...base,
      border: `1px solid ${active ? 'rgba(255,255,255,.25)' : '#DEDEE3'}`,
      background: 'transparent',
      color: active ? 'rgba(255,255,255,.7)' : '#6B6E76',
      cursor: 'default',
    };
  }
  if (active) {
    return { ...base, border: '1px solid #FFFFFF', background: '#FFFFFF', color: '#0A0A0B', cursor: 'pointer' };
  }
  if (kind === 'uninstall') {
    return { ...base, border: '1px solid var(--bad)', background: '#FFFFFF', color: 'var(--bad)', cursor: 'pointer' };
  }
  return { ...base, border: '1px solid #0E0E12', background: '#0E0E12', color: '#FFFFFF', cursor: 'pointer' };
}

export function connectorDocsIconBtnStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    width: CARD.docsBtnSize,
    height: CARD.docsBtnSize,
    flex: `0 0 ${CARD.docsBtnSize}px`,
    boxSizing: 'border-box',
    borderRadius: CONNECTIONS_RADIUS.chip,
    border: `1px solid ${active ? 'rgba(255,255,255,.3)' : '#DEDEE3'}`,
    color: active ? '#FFFFFF' : '#52555C',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: reducedMotion ? cardT('color', 120) : [cardT('border-color', 360), cardT('color', 360)].join(', '),
  };
}

// Dark (hover-view) text block — a single bottom-anchored block, its
// bottom edge 92px above the card bottom (clear of the 24px-inset, 44px-
// tall footer). Fades in + rises with a short delay so it visibly trails
// the card's own background/lift.
export function connectorDarkWrapStyle(active: boolean, reducedMotion: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: CARD.darkBottom,
    display: 'flex',
    flexDirection: 'column',
    opacity: active ? 1 : 0,
    transform: !reducedMotion && !active ? 'translateY(12px)' : 'translateY(0)',
    pointerEvents: active ? 'auto' : 'none',
    transition: reducedMotion
      ? cardT('opacity', 120)
      : `opacity 280ms ${CARD_EASE} ${active ? '120ms' : '0ms'}, transform 380ms ${CARD_EASE} ${active ? '80ms' : '0ms'}`,
  };
}

export const connectorDarkCategoryLabelStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,.5)',
};

export const connectorDarkNameStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  margin: '6px 0 0',
  fontSize: 26,
  lineHeight: '32px',
  fontWeight: 500,
  letterSpacing: '-.02em',
  color: '#FFFFFF',
};

export const connectorDarkSubtitleStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: '20px',
  color: 'rgba(255,255,255,.6)',
  marginTop: 2,
};

export const connectorDarkDescStyle: CSSProperties = {
  margin: '12px 0 0',
  fontSize: 14,
  lineHeight: '21px',
  color: 'rgba(255,255,255,.82)',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

export const connectionsEmptyResultsStyle: CSSProperties = {
  padding: '32px 0',
  fontSize: 13,
  color: '#6B6E76',
  textAlign: 'center',
};

// Real, active button for uninstalling an already-installed connector —
// same footprint as primaryBtnStyle's row but neutral coloring, so it
// reads as a secondary action next to "Add connection".
export const connectionsUninstallBtnStyle: CSSProperties = {
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  borderRadius: 9,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text-3)',
  cursor: 'pointer',
};

// Chat surface (/app/chat). Style values are ported from the exact CSS
// strings in designs/Nia Core App.html's `// ---------- chat ----------`
// view-model block — that block is otherwise orphaned (no JSX template in
// the design ever renders it, no nav entry ever sets page:'chat'), so
// there's no pixel-accurate screenshot reference; these are its extracted
// literal values (colors/radii/spacing), re-expressed as CSSProperties
// against this app's own token names (--text*/--line*/--acc* etc, not the
// design's raw --ink*/--acc* — see theme.css's [data-app-theme] alias
// block, both names resolve identically). Layout structure (composer row,
// mention dropdown, right-hand scope rail) is original, following this
// file's existing page conventions since no design layout exists to copy.

export const chatScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  overflow: 'hidden',
};

export const chatMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

export const chatMessageListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '40px 56px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
};

export function chatMessageWrapStyle(isUser: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    maxWidth: 660,
    alignSelf: isUser ? 'flex-end' : 'flex-start',
  };
}

export function chatMessageTextStyle(isUser: boolean): CSSProperties {
  return {
    fontSize: 13,
    lineHeight: 1.7,
    color: 'var(--text)',
    padding: isUser ? '10px 14px' : 0,
    borderRadius: isUser ? 14 : 0,
    background: isUser ? 'var(--surface2)' : 'transparent',
    border: 'none',
    whiteSpace: 'pre-wrap',
  };
}

export const chatCitationsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

export function chatCitationChipStyle(expanded: boolean): CSSProperties {
  return {
    height: 26,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 10px',
    borderRadius: 8,
    fontSize: 12,
    fontFamily: 'var(--font-data)',
    background: 'transparent',
    border: `1px solid ${expanded ? 'var(--acc-bd)' : 'var(--line2)'}`,
    color: expanded ? 'var(--acc)' : 'var(--text-3)',
    cursor: 'pointer',
  };
}

export const chatCitationExpandedStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
};

export const chatCitationExpandedTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-2)',
};

export const chatCitationExpandedSqlStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export const chatCitationExpandedMetaStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-3)',
};

export const chatCitationCopyBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--live)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

// Pre-token stage-progress line (status events before the first token
// arrives) — pulses via the existing `livePulse` keyframe (theme.css).
export const chatStatusRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12.5,
  color: 'var(--text-3)',
};

export const chatStatusDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  flex: 'none',
  borderRadius: '50%',
  background: 'var(--live)',
  animation: 'livePulse 1.4s ease-in-out infinite',
};

function chatBannerStyle(color: string, bg: string, bd: string): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '10px 14px',
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 1.6,
    color,
    background: bg,
    border: `1px solid ${bd}`,
  };
}

// Small inline note-with-icon (not a full banner) — CommandBar.tsx prefixes
// this with an "!" glyph, so this style is just the compact pill/row shell
// around that text.
function chatNoteStyle(color: string, bg: string, bd: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 1.4,
    color,
    background: bg,
    border: `1px solid ${bd}`,
    alignSelf: 'flex-start',
  };
}

// error: var(--bad); refused: var(--bad) (request-shape rejection, same
// treatment as a hard error); conflict: var(--warn) (sources disagreed,
// not a failure) — matches the ChatStreamEvent kind semantics in
// packages/schemas/src/chat.ts, not the design's mocked states.
export const chatErrorBannerStyle: CSSProperties = chatNoteStyle('var(--bad)', 'var(--bad-bg)', 'var(--bad-bd)');
export const chatRefusedBannerStyle: CSSProperties = chatBannerStyle('var(--bad)', 'var(--bad-bg)', 'var(--bad-bd)');
export const chatConflictBannerStyle: CSSProperties = chatBannerStyle('var(--warn)', 'var(--warn-bg)', 'var(--warn-bd)');

export const chatUnfaithfulNoteStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--warn)',
};

export const chatEmptyStateStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '40px 24px',
  textAlign: 'center',
};

export const chatEmptyTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.6rem',
  fontWeight: 700,
  letterSpacing: '-.03em',
  color: 'var(--text)',
};

export const chatEmptySubStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-3)',
  maxWidth: 420,
};

// Composer + @mention dropdown.
export const chatComposerWrapStyle: CSSProperties = {
  position: 'relative',
  flex: 'none',
  padding: '16px 56px 24px',
};

export function chatComposerStyle(focused: boolean): CSSProperties {
  return {
    height: 52,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 14px',
    borderRadius: 12,
    background: 'var(--surface)',
    border: `1px solid ${focused ? 'var(--acc-bd)' : 'var(--line)'}`,
    boxShadow: 'var(--amb)',
  };
}

export const chatComposerInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: '100%',
  fontFamily: 'inherit',
  fontSize: 13.5,
  color: 'var(--text)',
  background: 'transparent',
  border: 'none',
  outline: 'none',
};

export function chatSendBtnStyle(disabled: boolean): CSSProperties {
  return {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 32,
    boxSizing: 'border-box',
    padding: '0 14px',
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 500,
    borderRadius: 9,
    border: 'none',
    background: disabled ? 'var(--surface2)' : 'var(--live-fill)',
    color: disabled ? 'var(--text-4)' : 'var(--onacc)',
    cursor: disabled ? 'default' : 'pointer',
  };
}

export const chatMentionDropdownStyle: CSSProperties = {
  position: 'absolute',
  left: 56,
  right: 56,
  bottom: '100%',
  marginBottom: 8,
  maxHeight: 240,
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: 6,
  borderRadius: 12,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  boxShadow: 'var(--amb)',
  zIndex: 5,
};

export function chatMentionRowStyle(hovered: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    background: hovered ? 'var(--surface2)' : 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

export const chatMentionDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  flex: 'none',
  borderRadius: '50%',
  background: 'var(--ok)',
};

export const chatMentionHandleStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text)',
};

export const chatMentionToolStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-3)',
};

export const chatMentionEmptyStyle: CSSProperties = {
  padding: '10px 10px',
  fontSize: 12.5,
  color: 'var(--text-3)',
};

// Right-hand scope rail. Single-select only — apps/api's POST /chat
// currently rejects anything but exactly one connectionId (mirrors the
// worker's chat_query handler), so unlike the design's mocked
// `scope:{handle:true, ...}` multi-toggle object, only one row can be on
// at a time here (picking a new one turns the previous one off).
export const chatScopeRailStyle: CSSProperties = {
  flex: 'none',
  width: 260,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '40px 24px',
  borderLeft: '1px solid var(--line)',
  overflowY: 'auto',
};

export const chatScopeHeaderStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text)',
};

export const chatScopeHintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-3)',
};

export const chatScopeListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const chatScopeRowStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '10px 8px',
  borderRadius: 9,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
};

export function chatScopeSwitchStyle(on: boolean): CSSProperties {
  return {
    flex: 'none',
    width: 30,
    height: 18,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    padding: 2,
    borderRadius: 9,
    background: on ? 'var(--acc-solid)' : 'var(--surface2)',
    border: `1px solid ${on ? 'var(--acc-bd)' : 'var(--line2)'}`,
    transition: 'background .16s ease',
  };
}

export function chatScopeKnobStyle(on: boolean): CSSProperties {
  return {
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: on ? 'var(--onacc)' : 'var(--text-4)',
    transform: `translateX(${on ? 12 : 0}px)`,
    transition: 'transform .16s ease',
  };
}

export const chatScopeTextColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

export const chatScopeToolStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-3)',
};

export const chatScopeEmptyStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-3)',
};

// History list (left of the composer column, or a simple top strip — kept
// as a plain vertical list, following projectListStyle's convention).
export const chatHistoryListStyle: CSSProperties = {
  flex: 'none',
  width: 240,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '40px 12px',
  borderRight: '1px solid var(--line)',
  overflowY: 'auto',
};

export function chatHistoryRowStyle(active: boolean): CSSProperties {
  return {
    display: 'block',
    boxSizing: 'border-box',
    padding: '9px 12px',
    borderRadius: 9,
    fontSize: 12.5,
    color: active ? 'var(--text)' : 'var(--text-3)',
    background: active ? 'var(--surface2)' : 'transparent',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

export const chatHistoryHeaderStyle: CSSProperties = {
  padding: '0 12px 8px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-4)',
};

export const chatNewBtnStyle: CSSProperties = {
  margin: '0 12px 12px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 30,
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text)',
  cursor: 'pointer',
  textDecoration: 'none',
};

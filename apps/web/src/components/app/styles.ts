import type { CSSProperties } from 'react';
import type { WorkflowStatus } from '@/lib/dashboard/types';

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

// Nav rail group-section label ("PROJECTS", "PLATFORM") — Sidebar.tsx's
// only remaining consumer of this un-prefixed style; its pre-nx siblings
// (sidebarStyle, railHandleStyle, createWorkflowBtnStyle, navScrollStyle,
// navItemStyle, projectsParentRowStyle, navChevronStyle — all superseded
// by the navRail*/projectChevronStyle equivalents below) were removed in
// UI-9 step 3 once confirmed to have zero remaining references.
export const navGroupLabelStyle: CSSProperties = {
  padding: '22px 16px 8px',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export function projectChevronStyle(open: boolean): CSSProperties {
  return {
    flex: 'none',
    fontSize: 11,
    lineHeight: 1,
    color: 'var(--nx-ink-3)',
    transform: `rotate(${open ? 90 : 0}deg)`,
    // UI-9 step 3 (motion): normalized to the 120ms press duration + the
    // shared --nx-ease curve (was `.16s ease`).
    transition: 'transform 120ms var(--nx-ease)',
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

// No remaining direct JSX consumer — kept as the base object that
// nxOrgSwitcherBtnStyle (below) spreads and overrides for TopBar.tsx/
// CanvasHeader.tsx.
export const orgSwitcherBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--nx-ink)',
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
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

// Full-bleed section wrapper for the greeting block, matching the
// KPI strip / chart / table convention: own padding + a single
// border-bottom divider, no card box.
export const nxGreetingPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '32px 24px 28px',
  borderBottom: '1px solid var(--nx-line)',
};

// Precision Dark redesign (Step 3, Home): condensed-caps eyebrow above the
// greeting headline ("YOUR WORKSPACE").
export const nxGreetingTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 600,
  fontSize: 16,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
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

// Rebuilt to match HomeEarly.dc.html's solid-purple, 3-zone plan banner:
// a fixed 72px percent cell, a flex-grow body sentence, and a fixed
// 180px CTA cell, each divided by a border in the on-purple text color.
export const planBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  minHeight: 64,
  background: 'var(--nx-blue-panel)',
  color: 'var(--nx-blue-panel-text)',
  borderBottom: '1px solid var(--nx-line)',
  fontFamily: 'var(--nx-font-ui)',
};

export const planBannerPercentCellStyle: CSSProperties = {
  flex: 'none',
  width: 72,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 28,
  fontWeight: 500,
  letterSpacing: '-0.04em',
  fontVariantNumeric: 'tabular-nums',
  borderRight: '1px solid var(--nx-blue-panel-text)',
};

export const planBannerBodyStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  padding: '0 20px',
  fontSize: 15,
  lineHeight: '22px',
};

export const planBannerBtnStyle: CSSProperties = {
  flex: 'none',
  width: 180,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  borderLeft: '1px solid var(--nx-blue-panel-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-blue-panel-text)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
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
export const topBarSpacerStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: 0,
  paddingRight: 20,
};

export const topBarClockStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  color: 'var(--nx-ink-2)',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.02em',
  lineHeight: 1,
};

export const topBarClockColonStyle: CSSProperties = {
  display: 'inline-block',
  animation: 'nxColonBlink 1s step-end infinite',
};

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

// ---------------------------------------------------------------------
// Precision Dark redesign (Step 2): Sidebar + TopBar restyle. Where a
// style object above (orgSwitcherBtnStyle, dropdownStyle/dropdownItemStyle,
// breadcrumbSepStyle, pageCrumbLinkStyle/pageCrumbCurrentStyle) needed
// nx-token colours, a fresh nx-prefixed copy is defined here instead of
// editing the original in place — both TopBar.tsx and CanvasHeader.tsx
// (canvas header shell rebuild) import the nx-prefixed versions directly.
// TopBar-exclusive styles (topBarKbdStyle,
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
    right: -4,
    width: 8,
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
    gap: 12,
    padding: wide ? '0 16px' : 0,
    borderBottom: '1px solid var(--nx-line)',
  };
}

export const navWordmarkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 22,
  letterSpacing: '0.01em',
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
    padding: wide ? '8px 0 0' : '8px 0 0',
    gap: 0,
    boxSizing: 'border-box',
  };
}

export function navRailFooterStyle(): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 0,
    padding: 0,
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
    width: wide ? '100%' : '100%',
    // Full-bleed rows (item 7): 44px tall, edge to edge, no gap between
    // rows — separation comes from the bottom divider below instead.
    height: wide ? 44 : 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 12,
    borderRadius: 'var(--nx-radius)',
    fontSize: 15,
    border: 'none',
    borderBottom: wide ? '1px solid var(--nx-line-inner)' : 'none',
    cursor: 'pointer',
    marginBottom: 0,
    padding: wide ? '0 16px' : 0,
    textDecoration: 'none',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  };
}

export const navRailBtnLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 400,
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
  height: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: 'none',
  background: 'none',
  borderRadius: 'var(--nx-radius)',
  cursor: 'pointer',
  fontSize: 11,
  marginTop: 4,
  fontFamily: 'var(--nx-font-mono)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
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

// nx-themed TopBar — height 64. Now also CanvasHeader.tsx's shared shell
// (canvas header shell rebuild dropped its old 52px topBarStyle in favor
// of this one, matching the app shell exactly). Row itself carries no
// padding/gap any more — every child renders as its own full-height
// bordered "cell" (logo/org switcher/breadcrumbs/search/notifications/
// avatar), so spacing lives on the cells, not the row.
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
  gap: 10,
  color: 'var(--nx-ink)',
};

// Search cell (item 2 of the fix pass): a plain 280px cell with a single
// left divider — no inner boxed input, no bordered kbd chip. Pair with
// className="nx-wipe" on the outer cell for the hover background.
export const nxTopBarSearchCellStyle: CSSProperties = {
  flex: 'none',
  width: 300,
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
  // UI-9 step 3 (motion): 160ms fade + 4px slide — had no open animation
  // before this step.
  animation: 'nxMenuIn 160ms var(--nx-ease) both',
};

// UI-9 step 3 (motion): pair with className="nx-wipe" for hover/focus —
// had no hover treatment at all before this step (added to each JSX
// caller: TopBar.tsx, CanvasHeader.tsx).
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

// Precision Dark redesign (Step 3, Home): nx-token dialog shell used by
// CreateProjectDialog/CreateWorkflowDialog and (since UI-9) every other
// dialog in this scope — the pre-nx modal*Style family it replaced has
// been removed (UI-9 step 2: last consumers migrated onto this one).
// UI-9 step 3 (motion): scrim fade (180ms) + panel scale-up from .98
// (220ms) — the dialog shell had no mount animation before this step.
export const nxModalOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'color-mix(in srgb, var(--nx-bg) 78%, transparent)',
  animation: 'nxScrimIn 180ms var(--nx-ease) both',
};

export const nxModalCardStyle: CSSProperties = {
  width: 400,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  border: '1px solid var(--nx-ink-disabled)',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-bg)',
  display: 'flex',
  flexDirection: 'column',
  animation: 'nxPanelIn 220ms var(--nx-ease) both',
};

// Body is just a flex column now — each row (title, field) owns its own
// 20px padding + border-bottom divider, per the Step 3 dialog spec
// (DIALOGS section, HomeStates.dc.html), instead of one padded/gapped block.
export const nxModalBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

export const nxModalTitleRowStyle: CSSProperties = {
  padding: 20,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxModalTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 28,
  fontWeight: 500,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink)',
};

export const nxModalLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

// Standalone single-field row (e.g. CreateProjectDialog's Name field).
export const nxModalFieldRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 20,
  borderBottom: '1px solid var(--nx-line)',
};

// First of a stacked pair (e.g. CreateWorkflowDialog's Project field) — no
// divider of its own, tighter bottom padding than the row below it.
export const nxModalFieldRowTopStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '20px 20px 12px',
};

// Second/last of a stacked pair (e.g. CreateWorkflowDialog's Name field).
export const nxModalFieldRowStackedStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 20px 20px',
  borderBottom: '1px solid var(--nx-line)',
};

export function nxModalFieldStyle(hasError: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    height: 44,
    padding: '0 12px',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 15,
    color: 'var(--nx-ink)',
    background: 'var(--nx-surface)',
    border: `1px solid ${hasError ? 'var(--nx-danger)' : 'var(--nx-ink-disabled)'}`,
    borderRadius: 'var(--nx-radius)',
    outline: 'none',
  };
}

export const nxModalErrorStyle: CSSProperties = { fontSize: 12.5, color: 'var(--nx-danger-text)' };

// Footer: 52px row, a 110px "CANCEL" cell with a right divider, primary
// action filling the rest — per the Step 3 dialog spec.
export const nxModalFooterStyle: CSSProperties = {
  display: 'flex',
  height: 52,
  borderTop: '1px solid var(--nx-line)',
};

export const nxModalCancelCellStyle: CSSProperties = {
  width: 110,
  flex: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
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
    justifyContent: pending ? 'flex-start' : 'space-between',
    gap: 12,
    padding: '0 16px',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 15,
    color: pending ? 'var(--nx-blue-soft-text)' : 'var(--nx-blue-cta-text)',
    background: pending ? 'var(--nx-blue-tint)' : 'var(--nx-blue-cta)',
    border: 'none',
    cursor: pending ? 'default' : 'pointer',
  };
}

// ---------- CommandPalette (Precision Dark, Step 8A item 2) ----------
// Matches HomeStates.dc.html's "COMMAND PALETTE · ⌘K · STUB" board — a
// wider (640px) variant of the nxModal shell with its own header/search/
// results rows rather than the generic nxModalTitleRowStyle/nxModalFieldRowStyle.

export const nxCommandPaletteCardStyle: CSSProperties = {
  width: 640,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  border: '1px solid var(--nx-ink-disabled)',
  background: 'var(--nx-bg)',
  display: 'flex',
  flexDirection: 'column',
};

export const nxCommandPaletteHeaderStyle: CSSProperties = {
  flex: 'none',
  height: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxCommandPaletteHeaderTitleStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 20,
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
};

export const nxCommandPaletteEscStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const nxCommandPaletteSearchRowStyle: CSSProperties = {
  flex: 'none',
  height: 72,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '0 20px',
  borderBottom: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-3)',
};

export const nxCommandPaletteInputStyle: CSSProperties = {
  flex: 1,
  border: 'none',
  background: 'transparent',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 26,
  letterSpacing: '-0.02em',
  outline: 'none',
};

export const nxCommandPaletteResultsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: 20,
};

export const nxCommandPaletteSoonBadgeStyle: CSSProperties = {
  flex: 'none',
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  background: 'var(--nx-raised)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxCommandPaletteResultsTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: 'var(--nx-ink-2)',
};

// ---------- HelpPanel (Step 8A item 7): side panel, canvas-config-panel style ----------
// Anchored to the right edge over a dimmed backdrop (this component is a
// modal dialog — see HelpPanel.tsx's a11y comment — not a docked flex
// sibling like the canvas config panel, so it needs its own overlay rather
// than reusing nxModalOverlayStyle's centered one).

// UI-9 step 3 (motion): same dialog mount treatment as nxModalOverlayStyle/
// nxModalCardStyle above — this is a modal dialog per the a11y comment
// just above, so it gets the same scrim fade + panel scale, not a
// bespoke slide-in.
export const nxHelpPanelOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'flex-end',
  background: 'color-mix(in srgb, var(--nx-bg) 78%, transparent)',
  animation: 'nxScrimIn 180ms var(--nx-ease) both',
};

export const nxHelpPanelShellStyle: CSSProperties = {
  width: 420,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  borderLeft: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
  display: 'flex',
  flexDirection: 'column',
  outline: 'none',
  animation: 'nxPanelIn 220ms var(--nx-ease) both',
};

export const NX_HELP_PANEL_HEADER_HEIGHT = 56;

export const nxHelpPanelHeaderStyle: CSSProperties = {
  flex: 'none',
  height: NX_HELP_PANEL_HEADER_HEIGHT,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'space-between',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxHelpPanelTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 15,
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
  color: 'var(--nx-ink)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const nxHelpPanelCloseCellStyle: CSSProperties = {
  flex: 'none',
  width: NX_HELP_PANEL_HEADER_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderLeft: '1px solid var(--nx-line)',
  background: 'transparent',
  color: 'var(--nx-ink-2)',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
};

export const nxHelpPanelBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

export const nxHelpPanelSectionStyle: CSSProperties = {
  flex: 'none',
  padding: '16px 20px',
  borderBottom: '1px solid var(--nx-line)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const nxHelpPanelSectionLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxHelpPanelTextStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--nx-ink-2)',
};

export const nxHelpPanelListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const nxHelpPanelProblemRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const nxHelpPanelProblemLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--nx-ink)',
};

export const nxHelpPanelSqlBlockStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  padding: 10,
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
  color: 'var(--nx-ink)',
};

export const nxHelpPanelCopyBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  height: 30,
  padding: '0 12px',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  cursor: 'pointer',
};

export const nxHelpPanelWarnTextStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-warn)',
};

// Footer row — reserved "Still stuck?" slot (not built yet, see
// HelpPanel.tsx) as a nx-wipe row on the left, close on the right.
export const nxHelpPanelFooterStyle: CSSProperties = {
  flex: 'none',
  height: 52,
  display: 'flex',
  alignItems: 'stretch',
  borderTop: '1px solid var(--nx-line)',
};

export const nxHelpPanelFooterCloseStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '0 20px',
  display: 'flex',
  alignItems: 'center',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
  background: 'transparent',
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

// Connections page (/app/connections) types — still read by ConnectorCard.tsx,
// ConnectionsClient.tsx and lib/connections/catalogMeta.ts. The original
// pre-nx prototype styles these were declared alongside were removed in
// UI-9 step 2 (superseded by the nxConn* family below).
export type ConnectionHealth = 'ok' | 'idle' | 'error';
export type ConnectorCategory = 'databases' | 'warehouses' | 'bi' | 'ai-vector' | 'files';

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
  gap: 1,
  alignItems: 'stretch',
  background: 'var(--nx-line)',
};

// ---------------------------------------------------------------------------
// Precision Dark redesign (Step 4, Connections). Additive nx-* styles for
// /app/connections — connectionsAvailableGridStyle above is the one surviving
// legacy style (still imported elsewhere); everything below is new. See
// docs/plans' step notes for the governing spec. Only --nx-* tokens are used
// except the literal brand hexes drawn inside ConnectorLogo.tsx (never
// recolored, by design) and hardcoded 0s where the design calls for a hard
// Swiss-grid corner.
//
// Fidelity pass (Step 4b): rewritten value-for-value against
// designs/nia-design-source/Connections.dc.html — full-bleed sections
// divided by 1px --nx-line, cell padding only, no boxed buttons.
// ---------------------------------------------------------------------------

// Full-bleed page scroll container for /app/connections only — unlike
// homeScrollStyle (shared by Home/Members/Billing), this page has no outer
// padding/max-width; every section runs edge to edge and supplies its own
// cell padding.
export const nxConnScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

// Header: 280px-tall grid, title column (2fr) + counter column (1fr),
// divided by the section's 1px --nx-line border.
export const nxConnPageHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
  minHeight: 280,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxConnHeaderLeftColStyle: CSSProperties = {
  padding: '28px 40px 32px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  borderRight: '1px solid var(--nx-line)',
};

export const nxConnHeaderTopRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
};

export const nxConnPageTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

// Inert "Request a connector" strip — plain mono text, not a boxed button.
export const nxConnRequestBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: 0,
  border: 0,
  background: 'transparent',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  color: 'var(--nx-ink-disabled)',
  cursor: 'not-allowed',
};

export const nxConnSoonChipStyle: CSSProperties = {
  padding: '2px 6px',
  background: 'var(--nx-raised)',
  color: 'var(--nx-ink-2)',
};

export const nxConnTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const nxConnPageTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 112,
  lineHeight: '100px',
  fontWeight: 500,
  letterSpacing: '-0.055em',
  color: 'var(--nx-ink)',
};

export const nxConnPageSubtitleStyle: CSSProperties = {
  margin: 0,
  maxWidth: 620,
  fontSize: 16,
  lineHeight: '24px',
  color: 'var(--nx-ink-2)',
};

// Counter column: solid --nx-blue-panel block, full header height, split
// into the 2-cell counter row (top) + the canvas-hint strip (56px, bottom)
// by a 1px --nx-bg line (dark #0A0A0B / light #FAFAF8 — matches --nx-bg
// exactly in both themes).
export const nxConnCounterColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'minmax(0, 1fr) 56px',
  background: 'var(--nx-blue-panel)',
  color: 'var(--nx-blue-panel-text)',
};

export const nxConnCounterRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
};

export const nxConnCounterCellStyle = (last: boolean): CSSProperties => ({
  padding: '24px 28px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  borderRight: last ? 'none' : '1px solid var(--nx-bg)',
});

export const nxConnCounterLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 800,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

export const nxConnCounterValueStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 88,
  lineHeight: '80px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

// Bottom strip of the counter column — plain text, not a link/button.
export const nxConnCanvasHintStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 28px',
  borderTop: '1px solid var(--nx-bg)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.06em',
};

// Section header: 56px bar, title + count adjacent (not pushed far right).
export const nxConnSectionHeaderStyle: CSSProperties = {
  height: 56,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 28px',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxConnSectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 24,
  fontWeight: 800,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
};

export const nxConnSectionMetaStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

// Installed row: real CSS grid, matches the source's literal column
// template exactly. Dividers follow the source (logo cell + the two
// trailing action cells are bordered; the middle data cells share only
// their cell padding, no inner divider — mirrored, not the denser
// every-column-divided reading).
export const nxConnRowStyle: CSSProperties = {
  position: 'relative',
  height: 72,
  display: 'grid',
  gridTemplateColumns: '72px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.3fr) 150px 64px',
  alignItems: 'stretch',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxConnRowLogoCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--nx-line-inner)',
};

export const nxConnRowNameColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 2,
  minWidth: 0,
  padding: '0 20px',
};

export const nxConnRowNameStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxConnRowMetaStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxConnRowCountCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '0 20px',
};

// Count chip: filled --nx-blue-panel when the connector has connections,
// outlined --nx-line when it has none ("No connections yet").
export const nxConnBadgeStyle = (filled: boolean): CSSProperties => ({
  height: 24,
  boxSizing: 'border-box',
  padding: '0 8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  background: filled ? 'var(--nx-blue-panel)' : 'transparent',
  color: filled ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink-2)',
  border: filled ? 'none' : '1px solid var(--nx-line)',
});

export const nxConnRowHealthCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 20px',
};

// Health glyph (answer #7): glyph + short mono label only, no inline error
// text (error text stays in title/tooltip).
export type NxHealthStatus = 'ok' | 'error' | 'untested';

export const nxHealthGlyphStyle = (status: NxHealthStatus): CSSProperties => ({
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.03em',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color:
    status === 'ok'
      ? 'var(--nx-success)'
      : status === 'error'
        ? 'var(--nx-danger-text)'
        : 'var(--nx-ink-3)',
});

// UNINSTALL: a full-height, borderless (except its left divider) grid
// cell — no boxed button anywhere on this page.
export const nxConnDangerBtnStyle: CSSProperties = {
  border: 0,
  borderLeft: '1px solid var(--nx-line-inner)',
  borderRadius: 0,
  background: 'transparent',
  color: 'var(--nx-danger-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

// RowMenu restyle: bespoke portal/flip logic in ConnectionsClient.tsx is
// preserved verbatim — only the visual styles below change. Trigger is now
// the row's own 64px full-height grid cell.
export const nxConnRowMenuBtnStyle: CSSProperties = {
  border: 0,
  borderLeft: '1px solid var(--nx-line-inner)',
  borderRadius: 0,
  background: 'transparent',
  color: 'var(--nx-ink)',
  fontSize: 18,
  cursor: 'pointer',
};

// UI-9 step 3 (motion): 160ms fade + 4px slide — had no open animation
// before this step.
export const nxConnRowMenuPanelStyle: CSSProperties = {
  minWidth: 180,
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
  overflow: 'hidden',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  animation: 'nxMenuIn 160ms var(--nx-ease) both',
};

export const nxConnRowMenuItemStyle: CSSProperties = {
  height: 40,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '0 14px',
  fontSize: 12.5,
  color: 'var(--nx-ink)',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--nx-line-inner)',
  cursor: 'pointer',
  textAlign: 'left',
};

// CSV upload row — same row height as installed rows, its own 3-column
// grid: icon cell, name+meta cell, "Choose file" action cell.
export const nxConnUploadRowStyle: CSSProperties = {
  height: 72,
  display: 'grid',
  gridTemplateColumns: '72px minmax(0, 1fr) 190px',
  alignItems: 'stretch',
  color: 'var(--nx-ink-disabled)',
};

export const nxConnUploadIconCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--nx-line-inner)',
};

export const nxConnUploadIconStyle: CSSProperties = {
  width: 40,
  height: 40,
  boxSizing: 'border-box',
  border: '1px dashed var(--nx-line)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
};

export const nxConnUploadNameColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 2,
  padding: '0 20px',
};

export const nxConnUploadNameStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'var(--nx-ink-2)',
};

export const nxConnUploadMetaStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--nx-ink-3)',
};

export const nxConnUploadBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  border: 0,
  borderLeft: '1px solid var(--nx-line-inner)',
  borderRadius: 0,
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink-disabled)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  cursor: 'not-allowed',
};

// Empty/get-started panel.
export const nxConnEmptyPanelStyle: CSSProperties = {
  display: 'flex',
  gap: 32,
  flexWrap: 'wrap',
  padding: 28,
  border: '1px solid var(--nx-line)',
};

export const nxConnEmptyStepsColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  flex: '1 1 260px',
};

export const nxConnEmptyStepStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--nx-ink-2)',
};

export const nxConnEmptyStepNumStyle: CSSProperties = {
  width: 22,
  height: 22,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  border: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-3)',
};

export const nxConnEmptySuggestColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flex: '1 1 240px',
};

// Catalog toolbar: ONE 56px bar — search cell, category tabs, works-as
// tabs, all contiguous, sharing borders, no gaps, no individual pills.
export const nxConnToolbarRowStyle: CSSProperties = {
  height: 56,
  display: 'flex',
  alignItems: 'stretch',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxConnSearchCellStyle: CSSProperties = {
  width: 240,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 20px',
  borderRight: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-3)',
};

export const nxConnSearchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--nx-ink)',
  fontFamily: 'inherit',
  fontSize: 13,
};

export const nxConnSearchHintStyle: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  border: '1px solid var(--nx-line)',
  padding: '0 6px',
};

export const nxConnFilterListStyle: CSSProperties = {
  display: 'flex',
};

// Category tabs: condensed caps 17px/700, count inline at mono 12px.
export const nxConnFilterPillStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 16px',
  border: 0,
  borderRight: '1px solid var(--nx-line)',
  background: active ? 'var(--nx-ink)' : 'transparent',
  color: active ? 'var(--nx-bg)' : 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  cursor: 'pointer',
});

export const nxConnFilterCountStyle = (active: boolean): CSSProperties => ({
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  fontWeight: 400,
  opacity: 0.7,
  color: active ? 'var(--nx-bg)' : 'var(--nx-ink-2)',
});

// Works-as tabs: mono 12px, pushed to the far right via margin-left: auto.
export const nxConnWorksAsListStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  borderLeft: '1px solid var(--nx-line)',
};

export const nxConnWorksAsPillStyle = (active: boolean): CSSProperties => ({
  padding: '0 16px',
  border: 0,
  borderRight: '1px solid var(--nx-line)',
  background: active ? 'var(--nx-raised)' : 'transparent',
  color: active ? 'var(--nx-ink)' : 'var(--nx-ink-2)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
});

export const nxConnCatalogHintStyle: CSSProperties = {
  padding: '20px 28px',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxConnEmptyResultsStyle: CSSProperties = {
  padding: '40px 28px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--nx-ink-3)',
};

// Card v6 (fidelity pass): rewritten against the source's literal catalog
// card — 148px art band with a radial-dot pattern + 128px giant monogram,
// 52px action row, no card border (the grid's own 1px --nx-line gap
// reads as the hairline divider between cards).
export const NX_CARD = {
  art: 148,
  actionsHeight: 52,
} as const;

export const nxConnectorCardShellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 348,
  background: 'var(--nx-bg)',
};

export const nxConnectorCardArtStyle: CSSProperties = {
  position: 'relative',
  height: NX_CARD.art,
  overflow: 'hidden',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxConnectorCardDotsStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundImage: 'radial-gradient(circle, var(--nx-line-inner) 1px, transparent 1.4px)',
  backgroundSize: '6px 6px',
  WebkitMaskImage: 'linear-gradient(200deg, #000 0%, transparent 80%)',
  maskImage: 'linear-gradient(200deg, #000 0%, transparent 80%)',
};

export const nxConnectorCardCategoryStyle: CSSProperties = {
  position: 'absolute',
  left: 20,
  top: 16,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--nx-ink-2)',
  textTransform: 'uppercase',
};

// Badges: "N connected" filled --nx-blue-panel, "Installed" (0
// connections) --nx-ink filled, "Coming soon" --nx-raised.
export const nxConnectorCardBadgeStyle = (kind: 'connected' | 'installed' | 'soon'): CSSProperties => {
  const tone =
    kind === 'connected'
      ? { background: 'var(--nx-blue-panel)', color: 'var(--nx-blue-panel-text)' }
      : kind === 'installed'
        ? { background: 'var(--nx-ink)', color: 'var(--nx-bg)' }
        : { background: 'var(--nx-raised)', color: 'var(--nx-ink-2)' };
  return {
    position: 'absolute',
    right: 16,
    top: 14,
    height: 24,
    boxSizing: 'border-box',
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    ...tone,
  };
};

// Giant monogram fallback (no brand mark): a display rule per item 7 —
// --nx-blue-panel when installed/connected, --nx-raised otherwise
// (collapses the source's literal 3-way soon/installed/none split into
// this 2-way one, as explicitly requested).
export const nxConnectorCardGlyphStyle = (color: string): CSSProperties => ({
  position: 'absolute',
  left: 16,
  bottom: -12,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 128,
  lineHeight: '112px',
  fontWeight: 800,
  color,
});

export const nxConnectorCardBodyStyle: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '18px 20px',
};

export const nxConnectorCardNameStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 26,
  lineHeight: '30px',
  fontWeight: 500,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink)',
};

export const nxConnectorCardSubtitleStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxConnectorCardDescStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 14,
  lineHeight: '21px',
  color: 'var(--nx-ink-2)',
};

export const nxConnectorCardFactsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 4,
};

export const nxConnectorCardFactStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  letterSpacing: '0.03em',
  color: 'var(--nx-ink-3)',
  border: '1px solid var(--nx-line)',
  padding: '2px 6px',
};

export const nxConnectorCardActionsStyle: CSSProperties = {
  height: NX_CARD.actionsHeight,
  display: 'flex',
  borderTop: '1px solid var(--nx-line-inner)',
};

// No boxed buttons: INSTALL is an --nx-ink-filled cell, UNINSTALL/NOTIFY
// ME are transparent full-height cells, all UPPERCASE mono labels.
export const nxConnectorCardMainBtnStyle = (kind: 'install' | 'uninstall' | 'notify'): CSSProperties => ({
  flexGrow: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  border: 0,
  borderRadius: 0,
  background: kind === 'install' ? 'var(--nx-ink)' : 'transparent',
  color: kind === 'install' ? 'var(--nx-bg)' : kind === 'uninstall' ? 'var(--nx-danger-text)' : 'var(--nx-ink-disabled)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  fontWeight: kind === 'notify' ? 400 : 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: kind === 'notify' ? 'not-allowed' : 'pointer',
});

export const nxConnectorCardDocsBtnStyle: CSSProperties = {
  width: 76,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderLeft: '1px solid var(--nx-line-inner)',
  background: 'transparent',
  color: 'var(--nx-ink-2)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

// Destructive dialog extensions (answer #5) — layered on the existing
// nxModal* family from CreateProjectDialog's pattern.
export const nxModalDestructiveTagStyle: CSSProperties = {
  display: 'inline-block',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--nx-danger-text)',
};

export const nxModalBodyTextStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--nx-ink-2)',
};

export const nxModalDangerCellStyle = (pending: boolean): CSSProperties => ({
  flex: '1 1 auto',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  background: 'var(--nx-danger-text)',
  color: 'var(--nx-bg)',
  cursor: pending ? 'default' : 'pointer',
  opacity: pending ? 0.7 : 1,
});

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

// ---------- Projects list (Precision Dark redesign, Step 8B) ----------
// Matches Projects.dc.html / ProjectsStates.dc.html — 240px header (hero
// title in a 1fr left column + a 360px --nx-blue-panel counter column with
// a "New project" CTA strip underneath), then a bordered "ALL PROJECTS"
// table (index/name/workflows/last-activity/delete/arrow columns).

export const nxProjPageHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 360px',
  minHeight: 240,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxProjHeaderLeftColStyle: CSSProperties = {
  padding: '28px 40px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 14,
};

export const nxProjPageTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxProjPageTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 112,
  lineHeight: '100px',
  fontWeight: 500,
  letterSpacing: '-0.055em',
  color: 'var(--nx-ink)',
};

export const nxProjCounterColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'minmax(0, 1fr) 56px',
  background: 'var(--nx-blue-panel)',
  color: 'var(--nx-blue-panel-text)',
};

export const nxProjCounterRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
};

export const nxProjCounterCellStyle = (last: boolean): CSSProperties => ({
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  borderRight: last ? 'none' : '1px solid var(--nx-bg)',
});

export const nxProjCounterLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

export const nxProjCounterValueStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 72,
  lineHeight: '64px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

// "New project" CTA strip — invert-on-hover button (bg --nx-bg / ink idle),
// height 56, sits under the counter row, full width of the 360px column.
export const nxProjCounterCtaStyle: CSSProperties = {
  width: '100%',
  height: 56,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  border: 'none',
  borderTop: '1px solid var(--nx-bg)',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 16,
  cursor: 'pointer',
};

// Viewer replacement for the CTA strip — halftone-dot background (pair with
// className="nx-halftone") with a centered "VIEW ONLY" chip, no button.
export const nxProjViewOnlyStripStyle: CSSProperties = {
  height: 56,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderTop: '1px solid var(--nx-bg)',
};

export const nxProjViewOnlyChipStyle: CSSProperties = {
  height: 28,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 10px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxProjSectionHeaderStyle: CSSProperties = {
  height: 56,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 28px',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxProjSectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 24,
  fontWeight: 800,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
};

export const nxProjSectionMetaStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

const nxProjGridColumns = '72px minmax(0, 1fr) 180px 200px 120px 64px';

export const nxProjColHeaderRowStyle: CSSProperties = {
  height: 40,
  display: 'grid',
  gridTemplateColumns: nxProjGridColumns,
  alignItems: 'center',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxProjColHeaderCellStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxProjRowStyle: CSSProperties = {
  position: 'relative',
  height: 76,
  display: 'grid',
  gridTemplateColumns: nxProjGridColumns,
  alignItems: 'stretch',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxProjRowIndexCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 20,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

// Name link — pair with className="nx-wipe" for the hover background.
export const nxProjRowNameCellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  minWidth: 0,
  padding: '0 4px',
  textDecoration: 'none',
};

export const nxProjRowNameStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 22,
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxProjRowWorkflowsCellStyle = (has: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  textTransform: 'uppercase',
  color: has ? 'var(--nx-ink)' : 'var(--nx-ink-3)',
});

export const nxProjRowActivityCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxProjRowActivityDotStyle = (ran: boolean): CSSProperties => ({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: ran ? 'var(--nx-success)' : 'var(--nx-line)',
  flex: 'none',
});

// Delete cell — full-height grid cell, borderless button (className="nx-wipe").
export const nxProjRowDeleteCellStyle: CSSProperties = {
  border: 0,
  borderLeft: '1px solid var(--nx-line-inner)',
  borderRadius: 0,
  background: 'transparent',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-danger-text)',
  cursor: 'pointer',
};

export const nxProjRowArrowCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderLeft: '1px solid var(--nx-line-inner)',
  color: 'inherit',
  textDecoration: 'none',
};

// Empty-state box (writer: heading + subline + CTA; viewer: heading only) —
// pair with className="nx-halftone" for the dotted background.
export const nxProjEmptyBoxStyle: CSSProperties = {
  minHeight: 240,
  boxSizing: 'border-box',
  padding: '32px 24px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: 14,
};

export const nxProjEmptyHeadingStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 36,
  lineHeight: '38px',
  fontWeight: 500,
  letterSpacing: '-0.04em',
  color: 'var(--nx-ink)',
};

export const nxProjEmptySublineStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '21px',
  color: 'var(--nx-ink-2)',
};

export const nxProjEmptyCtaStyle: CSSProperties = {
  height: 48,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  alignSelf: 'flex-start',
  padding: '0 18px',
  background: 'var(--nx-blue-cta)',
  color: 'var(--nx-blue-cta-text)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 15,
  border: 'none',
  cursor: 'pointer',
};

// ---------- Project detail (Precision Dark redesign, Step 8B) ----------
// Matches ProjectDetail.dc.html / ProjectsStates.dc.html — 240px header
// (breadcrumb + hero name in a 1fr left column, a 280px --nx-blue-cta
// "New workflow" panel, a 64px kebab column), then a 1fr/420px body:
// a bordered "WORKFLOWS" table on the left, ProjectMembersPanel on the right.

export const nxProjDetailHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 280px 64px',
  minHeight: 240,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxProjDetailLeftColStyle: CSSProperties = {
  padding: '28px 40px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: 12,
};

export const nxProjDetailBreadcrumbStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxProjDetailTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 96,
  lineHeight: '88px',
  fontWeight: 500,
  letterSpacing: '-0.055em',
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxProjDetailMetaStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxProjDetailNewWorkflowBtnStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: 20,
  border: 'none',
  borderRight: '1px solid var(--nx-line)',
  background: 'var(--nx-blue-cta)',
  color: 'var(--nx-blue-cta-text)',
  cursor: 'pointer',
};

export const nxProjDetailNewWorkflowLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  opacity: 0.85,
};

export const nxProjDetailNewWorkflowTextRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 18,
};

// Viewer replacement for the New-workflow panel — same footprint, halftone
// background (className="nx-halftone").
export const nxProjDetailViewOnlyPanelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--nx-line)',
};

export const nxProjDetailKebabColStyle: CSSProperties = {
  position: 'relative',
};

export const nxProjDetailKebabBtnStyle = (open: boolean): CSSProperties => ({
  width: '100%',
  height: 64,
  border: 'none',
  borderBottom: '1px solid var(--nx-line)',
  background: open ? 'var(--nx-raised)' : 'transparent',
  color: 'var(--nx-ink)',
  fontSize: 18,
  cursor: 'pointer',
});

export const nxProjDetailDropdownStyle: CSSProperties = {
  position: 'absolute',
  top: 64,
  right: 0,
  width: 220,
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
};

export const nxProjDetailDropdownItemStyle = (destructive?: boolean): CSSProperties => ({
  height: 44,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '0 14px',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 14,
  color: destructive ? 'var(--nx-danger-text)' : 'var(--nx-ink)',
  background: 'transparent',
  border: 'none',
  borderBottom: destructive ? 'none' : '1px solid var(--nx-line-inner)',
  cursor: 'pointer',
  textAlign: 'left',
});

export const nxProjDetailBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 420px',
  minHeight: 0,
};

export const nxProjDetailWorkflowsColStyle: CSSProperties = {
  borderRight: '1px solid var(--nx-line)',
  minWidth: 0,
};

const nxProjDetailGridColumns = '56px minmax(0, 1fr) 140px 150px 64px';

export const nxProjDetailColHeaderRowStyle: CSSProperties = {
  height: 40,
  display: 'grid',
  gridTemplateColumns: nxProjDetailGridColumns,
  alignItems: 'center',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxProjDetailColHeaderCellStyle = (padLeft: number): CSSProperties => ({
  paddingLeft: padLeft,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
});

export const nxProjDetailRowStyle: CSSProperties = {
  height: 68,
  display: 'grid',
  gridTemplateColumns: nxProjDetailGridColumns,
  alignItems: 'stretch',
  borderBottom: '1px solid var(--nx-line-inner)',
  textDecoration: 'none',
  color: 'inherit',
};

export const nxProjDetailRowDotCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const nxProjDetailRowNameCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  paddingLeft: 4,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 19,
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxProjDetailRowStatusCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 20,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

export const nxProjDetailRowUpdatedCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 20,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
};

export const nxProjDetailRowArrowCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderLeft: '1px solid var(--nx-line-inner)',
};

export const nxProjDetailEmptyBoxStyle: CSSProperties = {
  minHeight: 240,
  boxSizing: 'border-box',
  padding: '32px 24px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
};

export const nxProjDetailEmptyTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 36,
  lineHeight: '38px',
  fontWeight: 500,
  letterSpacing: '-0.04em',
  color: 'var(--nx-ink)',
};

export const nxProjDetailMembersColStyle: CSSProperties = {
  minWidth: 0,
};

// Workflow status dot + ink vocabulary (active/paused/draft) — nx copy of
// the old statusDotStyle() above, which stays untouched (shared-style rule:
// this page gets its own copy rather than mutating the old one in place).
export function nxWorkflowStatusDotStyle(status: WorkflowStatus): CSSProperties {
  const color = status === 'active' ? 'var(--nx-blue-panel)' : status === 'paused' ? 'var(--nx-warn)' : 'var(--nx-ink-3)';
  const filled = status === 'active' || status === 'paused';
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    border: `1px solid ${color}`,
    background: filled ? color : 'transparent',
  };
}

export function nxWorkflowStatusInkColor(status: WorkflowStatus): string {
  return status === 'active' ? 'var(--nx-ink)' : status === 'paused' ? 'var(--nx-warn)' : 'var(--nx-ink-2)';
}

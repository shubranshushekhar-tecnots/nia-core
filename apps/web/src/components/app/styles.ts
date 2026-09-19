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
  background: 'var(--bg)',
  color: 'var(--text)',
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
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
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
    color: 'var(--text-4)',
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
// `padding-left` (24px project rows, 40px workflow rows, 30px "+ New
// project"), matching the design's indent ladder exactly.
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
    padding: '6px 8px 6px 24px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--surface2)' : 'transparent',
    color: 'var(--text-2)',
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
    padding: '6px 8px 6px 40px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--surface2)' : 'transparent',
    color: active ? 'var(--live-fill)' : 'var(--text-3)',
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
  padding: '7px 10px 7px 30px',
  fontSize: 12,
  color: 'var(--text-4)',
  background: 'transparent',
  border: 'none',
  borderRadius: 8,
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
};

export const greetingStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '2.4rem',
  fontWeight: 700,
  letterSpacing: '-.036em',
  lineHeight: 1.08,
};

export const greetingLineStyle: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--text-3)',
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
  padding: '16px 18px',
  borderRadius: 12,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  fontSize: 13.5,
};

export const planBannerBtnStyle: CSSProperties = {
  flex: 'none',
  height: 36,
  padding: '0 16px',
  borderRadius: 9,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--onacc)',
  background: 'var(--live-fill)',
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

export const sidebarUserAvatarStyle: CSSProperties = {
  width: 24,
  height: 24,
  flex: 'none',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  fontSize: 11,
  fontWeight: 600,
};

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

export const topBarSearchBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 30,
  padding: '0 8px 0 10px',
  borderRadius: 8,
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  color: 'var(--text-3)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

export const topBarKbdStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 11,
  padding: '2px 5px',
  borderRadius: 5,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  color: 'var(--text-4)',
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
  borderRadius: 8,
  background: 'transparent',
  border: 'none',
  color: 'var(--text-3)',
  fontSize: 15,
  cursor: 'pointer',
};

export const topBarAvatarBtnStyle: CSSProperties = {
  width: 26,
  height: 26,
  flex: 'none',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'inherit',
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

// Project detail page (/app/projects/[id]) — header row with breadcrumb +
// rename/delete kebab menu, plus its workflow list rows.
export const pageHeaderRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

// Page-level breadcrumb — "Projects / <project name>" only. The app-shell
// TopBar already renders "Nia Core / <workspace>"; this must not repeat
// it (ported from the design's isProject breadcrumb div, distinct from
// the TopBar's own brand crumb).
export const pageCrumbRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 13,
};

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

export const pageCrumbSepStyle: CSSProperties = { color: 'var(--text-4)' };
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
  color: 'var(--text-3)',
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

export const connectionsToolbarRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

export const connectionsSearchBoxStyle: CSSProperties = {
  flex: 1,
  height: 38,
  boxSizing: 'border-box',
  padding: '0 14px',
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text)',
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
  borderRadius: 999,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export function connectionsFilterPillStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 30,
    boxSizing: 'border-box',
    padding: '0 13px',
    borderRadius: 999,
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--text)' : 'transparent',
    color: active ? 'var(--onacc)' : 'var(--text-2)',
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
  color: 'var(--text)',
};

export const connectionsSectionMetaStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-3)',
};

export const connectionsProviderListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  overflow: 'hidden',
};

export function connectionsProviderRowStyle(bordered: boolean, dashed = false): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '18px 20px',
    borderBottom: bordered ? `1px ${dashed ? 'dashed' : 'solid'} var(--line)` : 'none',
  };
}

export const connectionsProviderIconStyle: CSSProperties = {
  width: 36,
  height: 36,
  flex: 'none',
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--ign-bg)',
  color: 'var(--ign-text)',
  fontSize: 13,
  fontWeight: 700,
};

// The Upload CSV/Excel row is visually distinct in the design: a dashed
// top border and a faint violet tint (var(--c-condition), the same token
// used for "condition"-kind canvas nodes / the files category).
export const connectionsUploadRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  flexWrap: 'wrap',
  padding: '18px 20px',
  borderTop: '1px dashed var(--line-strong)',
  background: 'color-mix(in srgb, var(--c-condition) 3%, transparent)',
};

export const connectionsUploadIconStyle: CSSProperties = {
  width: 40,
  height: 40,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 11,
  fontSize: 15,
  background: 'color-mix(in srgb, var(--c-condition) 10%, var(--surface))',
  color: 'var(--c-condition)',
};

export const connectionsUploadBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--c-condition)',
  background: 'var(--surface)',
  border: '1.5px solid var(--c-condition)',
  borderRadius: 9,
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
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--text)',
};

export const connectionsProviderMetaStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-3)',
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
    borderRadius: 999,
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
  color: 'var(--text-3)',
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

export const connectionsAvailableGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 20,
};

// Glassmorphic card shell, ported 1:1 from the design's connector-card
// markup (frosted background + soft indigo-tinted shadow).
export const connectionsConnectorCardStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  padding: '24px 22px 22px',
  minHeight: 344,
  borderRadius: 18,
  background: 'linear-gradient(165deg, rgba(255,255,255,.72), rgba(255,255,255,.5))',
  backdropFilter: 'blur(16px) saturate(1.6)',
  border: '1px solid rgba(255,255,255,.8)',
  outline: '1px solid rgba(203,213,225,.45)',
  boxShadow:
    'rgba(15,23,42,.05) 0 2px 6px, rgba(79,70,229,.16) 0 14px 34px -16px, rgba(255,255,255,.9) 0 1px 0 inset',
  transition: 'transform .3s cubic-bezier(.2,.7,.2,1), box-shadow .3s cubic-bezier(.2,.7,.2,1)',
};

// Applied on top of connectionsConnectorCardStyle while hovered (inline
// styles can't express :hover directly, and this codebase avoids
// className/global CSS for app-shell components — see AVAILABLE grid's
// onMouseEnter/onMouseLeave). Lift + deepen the shadow.
export const connectionsConnectorCardHoverStyle: CSSProperties = {
  transform: 'translateY(-4px)',
  boxShadow:
    'rgba(15,23,42,.08) 0 8px 16px, rgba(79,70,229,.26) 0 22px 44px -16px, rgba(255,255,255,.9) 0 1px 0 inset',
};

export const connectionsConnectorIndexStyle: CSSProperties = {
  position: 'relative',
  fontFamily: 'var(--font-display)',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--text-4)',
};

export const connectionsConnectorNameStyle: CSSProperties = {
  position: 'relative',
  maxWidth: '11ch',
  fontFamily: 'var(--font-display)',
  fontSize: 20,
  fontWeight: 700,
  lineHeight: 1.15,
  color: 'var(--text)',
};

export const connectionsConnectorDescStyle: CSSProperties = {
  position: 'relative',
  maxWidth: '24ch',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text-3)',
};

export const connectionsConnectorTagsStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

export const connectionsConnectorTagStyle: CSSProperties = {
  height: 20,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-2)',
  background: 'var(--surface2)',
};

export const connectionsInstallRowStyle: CSSProperties = {
  position: 'relative',
  marginTop: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 11,
};

// Default cursor is 'pointer' — this is shared by the real, clickable
// InstallButton (see ConnectionsClient) as well as the always-disabled
// decorative "Coming soon" button. Callers that render it disabled must
// override cursor to 'not-allowed' themselves (inline styles win over the
// browser's native disabled-cursor default, so it can't be left implicit).
export const connectionsInstallBtnStyle: CSSProperties = {
  width: 38,
  height: 38,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 15,
  lineHeight: 1,
  borderRadius: '50%',
  cursor: 'pointer',
  background: 'var(--text)',
  border: 'none',
  color: '#FFFFFF',
};

export const connectionsInstallLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text)',
};

// Decorative per-card graphic, anchored bottom-right, ported from the
// design: database/BI/warehouse/files connectors get 5 skewed, hue-shifted
// "stacked cards"; AI-vector connectors (pgvector, Pinecone) get a sphere
// with a highlight and 3 floating dots.
export const connectionsGraphicWrapStyle: CSSProperties = {
  position: 'absolute',
  right: -12,
  bottom: -12,
  width: 196,
  height: 196,
  pointerEvents: 'none',
};

const STACK_LAYERS = [
  { left: 0, top: 6, hue: -70 },
  { left: 20, top: 10, hue: -35 },
  { left: 40, top: 14, hue: 0 },
  { left: 60, top: 18, hue: 35 },
  { left: 80, top: 22, hue: 70 },
];

export function connectionsStackLayerStyle(i: number): CSSProperties {
  const layer = STACK_LAYERS[i]!;
  return {
    position: 'absolute',
    left: layer.left,
    top: layer.top,
    width: 70,
    height: 112,
    borderRadius: 14,
    transform: 'skewY(-10deg)',
    background: 'linear-gradient(160deg, rgba(165,243,252,.85), rgba(199,210,254,.82), rgba(251,207,232,.85))',
    filter: `hue-rotate(${layer.hue}deg)`,
    boxShadow: 'rgba(255,255,255,.9) 0 1px 0 inset, rgba(79,70,229,.5) 0 8px 18px -10px',
  };
}

export const STACK_LAYER_COUNT = STACK_LAYERS.length;

export const connectionsSphereMainStyle: CSSProperties = {
  position: 'absolute',
  left: 34,
  top: 26,
  width: 116,
  height: 116,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 32% 28%, #FFFFFF, #FBCFE8 34%, #C7D2FE 62%, #A7F3D0 100%)',
  boxShadow: 'rgba(79,70,229,.28) -8px -10px 22px inset, rgba(124,58,237,.5) 0 16px 30px -14px',
};

export const connectionsSphereHighlightStyle: CSSProperties = {
  position: 'absolute',
  left: 58,
  top: 44,
  width: 44,
  height: 22,
  borderRadius: '50%',
  background: 'rgba(255,255,255,.75)',
  filter: 'blur(6px)',
};

const SPHERE_DOTS = [
  { left: 14, top: 120, size: 16, gradient: 'linear-gradient(160deg, #C7D2FE, #A7F3D0)' },
  { left: 150, top: 96, size: 12, gradient: 'linear-gradient(160deg, #FBCFE8, #C7D2FE)' },
  { left: 126, top: 150, size: 9, gradient: 'linear-gradient(160deg, #A7F3D0, #C7D2FE)' },
];

export function connectionsSphereDotStyle(i: number): CSSProperties {
  const dot = SPHERE_DOTS[i]!;
  return {
    position: 'absolute',
    left: dot.left,
    top: dot.top,
    width: dot.size,
    height: dot.size,
    borderRadius: '50%',
    background: dot.gradient,
  };
}

export const SPHERE_DOT_COUNT = SPHERE_DOTS.length;

export const connectionsEmptyResultsStyle: CSSProperties = {
  padding: '32px 0',
  fontSize: 13,
  color: 'var(--text-3)',
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

// "Unavailable" cards (no manifest and nothing planned near-term, e.g.
// AWS/Notion) — ported from the design's "SOON" badge + "On the roadmap"
// row, which replaces the Install control entirely rather than just
// disabling it.
export const connectionsSoonBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 20,
  height: 20,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  borderRadius: 6,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: 'var(--text-4)',
  background: 'var(--surface2)',
};

export const connectionsUnavailableNameStyle: CSSProperties = {
  ...connectionsConnectorNameStyle,
  color: 'var(--text-4)',
};

export const connectionsUnavailableDescStyle: CSSProperties = {
  ...connectionsConnectorDescStyle,
  color: 'var(--text-4)',
};

export const connectionsRoadmapRowStyle: CSSProperties = {
  position: 'relative',
  marginTop: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 11,
};

export const connectionsRoadmapIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  background: 'transparent',
  border: '1px solid var(--line-strong)',
  color: 'var(--text-4)',
};

export const connectionsRoadmapLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-4)',
};

// Faint diagonal hatch swapped in for the vivid stacked-cards/sphere
// graphic on unavailable cards — same wrap box, far lower contrast, masked
// to fade out toward the top-left like the design's version does.
export const connectionsUnavailableGraphicStyle: CSSProperties = {
  position: 'absolute',
  right: -12,
  bottom: -12,
  width: 196,
  height: 196,
  pointerEvents: 'none',
  opacity: 0.6,
  background:
    'repeating-linear-gradient(135deg, var(--line) 0, var(--line) 1px, transparent 1px, transparent 14px)',
  maskImage: 'radial-gradient(circle at 70% 70%, black 0%, transparent 70%)',
  WebkitMaskImage: 'radial-gradient(circle at 70% 70%, black 0%, transparent 70%)',
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

// CommandBar's "/" suggestion menu — same visual language as the
// chatMention* dropdown above (positioned above the bar, card rows with
// hover state), just for example Copilot prompts instead of connections.
export const chatSlashMenuDropdownStyle: CSSProperties = {
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

export function chatSlashMenuRowStyle(hovered: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    padding: '8px 10px',
    borderRadius: 8,
    background: hovered ? 'var(--surface2)' : 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

export const chatSlashMenuLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text)',
};

export const chatSlashMenuHintStyle: CSSProperties = {
  fontSize: 11.5,
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

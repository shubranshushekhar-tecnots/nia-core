import type { CSSProperties } from 'react';

// Console v1 (docs/plans/console-plan.md §5a, decision 3) — ported
// pixel-for-pixel from designs/Nia Console (superadmin).html's inline style
// strings (extracted via byte-offset reads of that file's bundled JS, since
// it's a single ~723KB line). Kept in its own file/namespace rather than
// apps/web/src/components/app/styles.ts since Console is a separate,
// staff-only surface with its own shell.

export const consoleShellRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'var(--font-ui)',
  WebkitFontSmoothing: 'antialiased',
};

export const consoleTopBarStyle: CSSProperties = {
  flex: 'none',
  height: 52,
  boxSizing: 'border-box',
  padding: '0 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  background: 'var(--surface)',
  borderBottom: '1px solid var(--line2)',
};

export const consoleBrandMarkStyle: CSSProperties = {
  width: 24,
  height: 24,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  background: 'linear-gradient(145deg,#6366F1,#4338CA)',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 700,
};

export const consoleBrandTextStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '-.02em',
};

export const consoleInternalBadgeStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: 7,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '.14em',
  color: 'var(--warning-deep)',
  background: 'rgba(245,158,11,.06)',
  border: '1px dashed rgba(245,158,11,.65)',
};

export const consoleTopBarSpacerStyle: CSSProperties = { flex: 1 };

export const consoleIdentityWrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  paddingLeft: 6,
  borderLeft: '1px solid var(--line)',
};

export const consoleIdentityAvatarStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  background: 'var(--primary-soft)',
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--primary)',
};

export const consoleIdentityColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.3,
};

export const consoleIdentityNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--text)',
};

export const consoleIdentitySubStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
};

// design's `ghost()` helper — used for the sign-out button.
export const consoleGhostBtnStyle: CSSProperties = {
  flex: 'none',
  height: 30,
  boxSizing: 'border-box',
  padding: '0 11px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  borderRadius: 8,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  color: 'var(--secondary)',
  cursor: 'pointer',
};

export const consoleBodyRowStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
};

export const consoleSidebarStyle: CSSProperties = {
  width: 212,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '14px 10px',
  background: 'var(--surface)',
  borderRight: '1px solid var(--line)',
};

// `active` mirrors the design's NAV.map active-state logic; `enabled` is a
// Slice 1 addition (not in the design) for the 6 nav items not built yet —
// they render inert/dimmed rather than as working links, so the sidebar
// still shows the full design (decision 3) without claiming functionality
// that doesn't exist yet.
export function consoleNavItemStyle(active: boolean, enabled: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    border: 'none',
    cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'inherit',
    fontSize: 13.5,
    fontWeight: active ? 700 : 500,
    background: active ? 'var(--primary-soft)' : 'transparent',
    color: !enabled ? 'var(--text-4)' : active ? 'var(--primary)' : 'var(--secondary)',
    textDecoration: 'none',
  };
}

export function consoleNavIconStyle(active: boolean): CSSProperties {
  return {
    flex: 'none',
    width: 16,
    textAlign: 'center',
    fontSize: 12,
    color: active ? 'var(--primary)' : 'var(--muted)',
  };
}

export const consoleSidebarFooterStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 10px',
  borderTop: '1px solid var(--line)',
};

export const consoleSidebarFooterLabelStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

export const consoleSidebarFooterValueStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
};

export const consoleMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg)',
};

export const consoleContentStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '34px 34px 80px',
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
};

export const consoleHeaderRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 20,
  flexWrap: 'wrap',
};

export const consoleHeaderTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

export const consoleHeaderTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.66rem',
  fontWeight: 700,
  letterSpacing: '-.032em',
  lineHeight: 1.1,
};

export const consoleHeaderSubStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--ink3)',
};

export const consoleTabsRowStyle: CSSProperties = { display: 'flex', gap: 6 };

// design's `tab(on)` helper.
export function consoleTabStyle(on: boolean): CSSProperties {
  return {
    height: 30,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 13px',
    borderRadius: 9,
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: on ? 700 : 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    background: on ? 'var(--primary-soft)' : 'transparent',
    border: 'none',
    color: on ? 'var(--primary)' : 'var(--secondary)',
  };
}

export const consoleToolbarRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

export const consoleSearchStyle: CSSProperties = {
  flex: '1 1 260px',
  minWidth: 200,
  boxSizing: 'border-box',
  height: 36,
  padding: '0 12px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--ink)',
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  outline: 'none',
};

export const consoleTableStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };

export const consoleTableHeadRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '9px 0',
  borderBottom: '1px solid var(--line2)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
};

export const consoleColAccountStyle: CSSProperties = { flex: '2 1 200px', minWidth: 150 };
export const consoleColPlanStyle: CSSProperties = { flex: '0 1 110px', minWidth: 88 };
export const consoleColMembersStyle: CSSProperties = { flex: '0 1 84px', minWidth: 66, textAlign: 'right' };
export const consoleColRunsStyle: CSSProperties = { flex: '0 1 86px', minWidth: 70, textAlign: 'right' };
export const consoleColStatusStyle: CSSProperties = { flex: '0 1 100px', minWidth: 86 };

export const consoleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '13px 0',
  borderBottom: '1px solid var(--line)',
};

export const consoleRowAccountCellStyle: CSSProperties = {
  flex: '2 1 200px',
  minWidth: 150,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

// design's `mono()` helper — the two-letter avatar chip.
export const consoleMonoStyle: CSSProperties = {
  width: 36,
  height: 36,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 10,
  background: 'var(--subtle)',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--secondary)',
};

export const consoleRowNameColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.35,
  minWidth: 0,
};

export const consoleRowNameStyle: CSSProperties = {
  padding: 0,
  fontSize: 13,
  color: 'var(--ink)',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleRowKindStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 11,
  color: 'var(--ink4)',
};

export const consoleRowPlanStyle: CSSProperties = {
  flex: '0 1 110px',
  minWidth: 88,
  fontSize: 12.5,
  color: 'var(--ink2)',
};

export const consoleRowNumberStyle: CSSProperties = {
  flex: '0 1 84px',
  minWidth: 66,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--ink2)',
};

// design's `pill(tone)` helper.
export function consolePillStyle(tone: 'ok' | 'warn' | 'bad' | 'neutral'): CSSProperties {
  const map: Record<'ok' | 'warn' | 'bad' | 'neutral', [string, string]> = {
    ok: ['var(--success-deep)', 'rgba(16,185,129,.12)'],
    warn: ['var(--warning-deep)', 'rgba(245,158,11,.14)'],
    bad: ['var(--error-deep)', 'rgba(239,68,68,.12)'],
    neutral: ['var(--secondary)', 'var(--subtle)'],
  };
  const [color, background] = map[tone];
  return {
    display: 'inline-flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    padding: '4px 12px',
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    color,
    background,
    border: 'none',
  };
}

export const consoleEmptyStyle: CSSProperties = {
  padding: '13px 0',
  fontSize: 12.5,
  color: 'var(--ink3)',
};

// Slice 1 review fix (console-plan.md decision 10) — "Load more" row below
// the table. Not in the original design file (which never truncated its
// mock data); reuses consoleGhostBtnStyle rather than inventing a new
// button treatment.
export const consoleLoadMoreRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  paddingTop: 4,
};

export const consoleLoadMoreErrorStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--error-deep)',
};

// Small fixes (2026-09-29): the Runs tab's "Showing the latest 50 runs"
// caption — same muted treatment as consoleEmptyStyle, but a caption sits
// above the table (not inside it as the sole row), so it's a separate
// style rather than reusing consoleEmptyStyle's row padding.
export const consoleRunsCaptionStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--ink3)',
  paddingBottom: 8,
};

// Org Detail screen (Slice 2, console-plan.md build order steps 6-7).
// Breadcrumb/header/tabs ported pixel-for-pixel from designs/Nia Console
// (superadmin).html's isOrgDetail template. See ConsoleOrgDetailClient's own
// doc comment for exactly which design elements are omitted this slice
// (header action buttons, non-Members tabs, per-row member menu) and why.

export const consoleBreadcrumbRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 13,
};

export const consoleBreadcrumbLinkStyle: CSSProperties = {
  padding: 0,
  fontSize: 13,
  color: 'var(--ink3)',
  background: 'transparent',
  border: 'none',
  textDecoration: 'none',
  cursor: 'pointer',
};

export const consoleBreadcrumbSepStyle: CSSProperties = { color: 'var(--ink4)' };

export const consoleBreadcrumbCurrentStyle: CSSProperties = { color: 'var(--ink2)' };

export const consoleDetailHeaderTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

// Slice 2 addition, not in the design (which folds plan into orgMeta only):
// console-plan.md decision 8 requires plan/limits/usage to be visible on
// this screen, and there's no design slot for it, so a small stat-card row
// (same visual language as the design's existing `pill`/`surface` tokens)
// is added directly below the header.
export const consoleStatsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
};

export const consoleStatCardStyle: CSSProperties = {
  flex: '1 1 160px',
  minWidth: 140,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export const consoleStatLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
};

export const consoleStatValueStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 18,
  fontWeight: 700,
  color: 'var(--ink)',
};

// Slice 3a (docs/plans/console-plan.md): inline plan-edit control on the
// stat-card row. No modal — Console's own established minimalist
// convention (see ConsoleOrgDetailClient's doc comment) plus the fact this
// is a two-field edit, not worth a dialog: an "Edit plan" ghost button
// (reuses consoleGhostBtnStyle) toggles the stat row into this form, which
// replaces it in place.
export const consolePlanFormStyle: CSSProperties = {
  flex: '1 1 100%',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export const consolePlanFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const consolePlanFieldLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
};

export const consolePlanInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 160,
  height: 32,
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--ink)',
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  outline: 'none',
};

export const consolePlanFormActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

// design's `primary()` helper — used for the plan form's Save button, the
// one write action on this screen.
export const consolePrimaryBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  borderRadius: 8,
  background: 'var(--primary)',
  border: '1px solid var(--primary)',
  color: '#FFFFFF',
  cursor: 'pointer',
};

export const consolePlanFormErrorStyle: CSSProperties = {
  flex: '1 1 100%',
  fontSize: 12.5,
  color: 'var(--error-deep)',
};

export const consolePlanFormWarningStyle: CSSProperties = {
  flex: '1 1 100%',
  fontSize: 12.5,
  color: 'var(--warning-deep)',
};

export const consoleSectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
};

// Slice 3b (docs/plans/console-plan.md, decisions 1-2, additions 3-6):
// the header action buttons the design has (`isOrgDetail` template) but
// this build deliberately omitted through Slice 2/3a (see
// ConsoleOrgDetailClient's doc comment) — suspend/unsuspend is now real,
// so its one header action is added. Danger-styled (design's `danger()`
// helper): reuses the same `--error`/`--error-deep` tokens already used
// elsewhere on this screen (consolePlanFormErrorStyle,
// consoleLoadMoreErrorStyle) rather than inventing new ones.
export const consoleHeaderActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const consoleDangerBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  borderRadius: 8,
  background: 'var(--error)',
  border: '1px solid var(--error)',
  color: '#FFFFFF',
  cursor: 'pointer',
};

// Suspended-state pill shown next to the org name in the header — same
// --bad-bg/--bad-bd/--bad tokens SuspendedOrgPage.tsx (apps/app-side
// suspension screen) uses, so the two surfaces read as the same concept.
export const consoleSuspendedBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 9px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.02em',
  background: 'var(--bad-bg)',
  border: '1px solid var(--bad-bd)',
  color: 'var(--bad)',
};

// Suspend/unsuspend inline forms — same card treatment as
// consolePlanFormStyle, full-width block below the header rather than a
// modal (Console's established minimalist convention, see
// ConsoleOrgDetailClient's doc comment).
export const consoleSuspendFormStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--surface)',
  border: '1px solid var(--bad-bd)',
};

export const consoleSuspendTextareaStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 64,
  padding: '8px 10px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--ink)',
  background: 'var(--surface2)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  outline: 'none',
  resize: 'vertical',
};

export const consoleSuspendMetaStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink3)',
};

// Members table column widths ported from the design's Member/Email/Role
// columns exactly; "Joined" replaces the design's "Last active"/"Status"
// columns (no last-active tracking or member-suspension mechanism exists
// yet — see ConsoleOrgDetailClient's doc comment).
export const consoleColMemberStyle: CSSProperties = { flex: '2 1 180px', minWidth: 140 };
export const consoleRowMemberCellStyle: CSSProperties = {
  flex: '2 1 180px',
  minWidth: 140,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};
export const consoleColEmailStyle: CSSProperties = { flex: '1 1 160px', minWidth: 120 };
export const consoleColRoleStyle: CSSProperties = { flex: '0 1 100px', minWidth: 82 };
export const consoleColJoinedStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
};

export const consoleRowEmailCellStyle: CSSProperties = {
  flex: '1 1 160px',
  minWidth: 120,
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--ink3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleRowRoleCellStyle: CSSProperties = {
  flex: '0 1 100px',
  minWidth: 82,
  fontSize: 12.5,
  color: 'var(--ink2)',
};

export const consoleRowJoinedCellStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--ink4)',
};

// Directory row → Org Detail link (Slice 2 addition; the design's row-level
// `open` handler is now a real navigation, not a state toggle).
export const consoleRowLinkStyle: CSSProperties = {
  textDecoration: 'none',
  color: 'inherit',
  cursor: 'pointer',
};

// Runs table (Slice 3c, docs/plans/console-plan.md decision 9). Not in the
// original design file (which has no Runs tab data) — column widths follow
// the same flex-basis convention as the Members table above rather than
// inventing a new layout language. "Error" is the widest column since it's
// the one piece of information this tab exists to surface.
export const consoleColRunStatusStyle: CSSProperties = { flex: '0 1 90px', minWidth: 78 };
export const consoleColRunStartedStyle: CSSProperties = { flex: '0 1 150px', minWidth: 130 };
export const consoleColRunDurationStyle: CSSProperties = { flex: '0 1 90px', minWidth: 78, textAlign: 'right' };
export const consoleColRunErrorStyle: CSSProperties = { flex: '2 1 240px', minWidth: 160 };

export const consoleRowRunStatusCellStyle: CSSProperties = { flex: '0 1 90px', minWidth: 78 };
export const consoleRowRunStartedCellStyle: CSSProperties = {
  flex: '0 1 150px',
  minWidth: 130,
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--ink3)',
};
export const consoleRowRunDurationCellStyle: CSSProperties = {
  flex: '0 1 90px',
  minWidth: 78,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--ink2)',
};
export const consoleRowRunErrorCellStyle: CSSProperties = {
  flex: '2 1 240px',
  minWidth: 160,
  fontSize: 12,
  color: 'var(--ink3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Connectors table (Slice 3d, docs/plans/console-plan.md build order step
// 11). Same flex-basis convention as the Members/Runs tables above. "Type"
// is the connector_id slug (e.g. "mysql"), "Health" is the last-test
// status pill (same consolePillStyle helper the Runs tab's status column
// already uses) plus latency when available.
export const consoleColConnectorTypeStyle: CSSProperties = { flex: '0 1 110px', minWidth: 90 };
export const consoleColConnectorNameStyle: CSSProperties = { flex: '2 1 200px', minWidth: 150 };
export const consoleColConnectorHealthStyle: CSSProperties = { flex: '0 1 150px', minWidth: 130 };
export const consoleColConnectorCreatedStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
};

export const consoleRowConnectorTypeCellStyle: CSSProperties = {
  flex: '0 1 110px',
  minWidth: 90,
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--ink3)',
};
export const consoleRowConnectorNameCellStyle: CSSProperties = {
  flex: '2 1 200px',
  minWidth: 150,
  fontSize: 13,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
export const consoleRowConnectorHealthCellStyle: CSSProperties = {
  flex: '0 1 150px',
  minWidth: 130,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
export const consoleRowConnectorHealthLatencyStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 11,
  color: 'var(--ink4)',
};
export const consoleRowConnectorCreatedCellStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--ink4)',
};

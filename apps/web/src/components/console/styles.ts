import type { CSSProperties } from 'react';

// Console v1 (docs/plans/console-plan.md §5a, decision 3) — ported
// pixel-for-pixel from designs/Nia Console (superadmin).html's inline style
// strings (extracted via byte-offset reads of that file's bundled JS, since
// it's a single ~723KB line). Kept in its own file/namespace rather than
// apps/web/src/components/app/styles.ts since Console is a separate,
// staff-only surface with its own shell.
//
// Console dark/red/square theme pass: every export below now reads from the
// `--c-*` token namespace ([data-theme="console"] in packages/ui/src/
// theme.css) instead of the shared `--nx-*` tokens, so Console's look can
// never change/leak as a side effect of the customer app's theme toggle.
// Also applies the spec's global rules: `--c-radius` is always 0 (square
// corners everywhere), font weights are capped at 600 (no 700s), and numeric
// columns get `fontVariantNumeric: 'tabular-nums'` + right alignment.

export const consoleShellRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--c-bg)',
  color: 'var(--c-text)',
  fontFamily: 'var(--c-font-sans)',
  WebkitFontSmoothing: 'antialiased',
};

// Thin strip rendered as the very first child of the shell root, above the
// top bar, so Console is visually distinguishable at a glance from the
// customer app shell even on a screenshot that crops out the "STAFF" badge.
export const consoleStaffBarStyle: CSSProperties = {
  flex: 'none',
  height: 2,
  background: 'var(--c-accent)',
};

export const consoleTopBarStyle: CSSProperties = {
  flex: 'none',
  height: 52,
  boxSizing: 'border-box',
  padding: '0 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  background: 'var(--c-surface)',
  borderBottom: '1px solid var(--c-line)',
};

export const consoleBrandMarkStyle: CSSProperties = {
  width: 24,
  height: 24,
  flex: 'none',
  borderRadius: 0,
  objectFit: 'cover',
};

export const consoleBrandTextStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '-.01em',
};

// Single "STAFF" badge next to the brand mark (spec: one badge, no separate
// dashed "INTERNAL" badge — ConsoleShell.tsx no longer renders one).
export const consoleStaffBadgeStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 9px',
  borderRadius: 0,
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--c-accent-text)',
  background: 'var(--c-accent-soft)',
  border: '1px solid var(--c-accent-line)',
};

export const consoleTopBarSpacerStyle: CSSProperties = { flex: 1 };

// Environment label (LOCAL/PROD) shown before the identity block. No
// existing env-detection convention in apps/web beyond NODE_ENV — see
// ConsoleShell.tsx for how `env` is derived. Flags red when PROD.
export function consoleEnvLabelStyle(env: 'LOCAL' | 'PROD'): CSSProperties {
  const isProd = env === 'PROD';
  return {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    height: 22,
    padding: '0 8px',
    borderRadius: 0,
    fontFamily: 'var(--c-font-mono)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: isProd ? 'var(--c-error)' : 'var(--c-text-3)',
    background: isProd ? 'var(--c-error-bg)' : 'var(--c-surface-2)',
    border: isProd ? '1px solid var(--c-error)' : '1px solid var(--c-line-strong)',
  };
}

export const consoleIdentityWrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  paddingLeft: 6,
  borderLeft: '1px solid var(--c-line)',
};

// Square 32px avatar (spec: square corners everywhere — no circular chips).
export const consoleIdentityAvatarStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 0,
  background: 'var(--c-accent-soft)',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--c-accent-text)',
};

export const consoleIdentityColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.3,
};

export const consoleIdentityNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--c-text)',
};

export const consoleIdentitySubStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};

// design's `ghost()` helper — used for the sign-out button.
export const consoleGhostBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 11px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line-strong)',
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

export const consoleBodyRowStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
};

// 240px wide per spec (was 212px).
export const consoleSidebarStyle: CSSProperties = {
  width: 240,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '14px 10px',
  background: 'var(--c-surface)',
  borderRight: '1px solid var(--c-line)',
};

// `active` mirrors the design's NAV.map active-state logic; `enabled` is a
// Slice 1 addition (not in the design) for nav items not built yet — they
// render inert/dimmed rather than as working links.
export function consoleNavItemStyle(active: boolean, enabled: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 0,
    border: 'none',
    cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'var(--c-font-sans)',
    fontSize: 13,
    lineHeight: '20px',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--c-accent-soft)' : 'transparent',
    color: !enabled ? 'var(--c-text-disabled)' : active ? 'var(--c-accent-text)' : 'var(--c-text-2)',
    textDecoration: 'none',
  };
}

// Icon slot now hosts an inline SVG component (icons.tsx) instead of a
// Unicode glyph string — this only needs to color it, sizing lives on the
// SVG itself.
export function consoleNavIconStyle(active: boolean): CSSProperties {
  return {
    flex: 'none',
    width: 16,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: active ? 'var(--c-accent-text)' : 'var(--c-text-3)',
  };
}

// Small uppercase label above each grouped nav section ("DASHBOARD",
// "USERS & ACCESS", etc.).
export const consoleNavGroupLabelStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--c-text-3)',
  padding: '12px 10px 4px',
};

export const consoleSidebarFooterStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 10px',
  borderTop: '1px solid var(--c-line)',
};

export const consoleSidebarFooterLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--c-text-3)',
};

// Build value reads as data, not prose — mono per spec.
export const consoleSidebarFooterValueStyle: CSSProperties = {
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};

export const consoleMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--c-bg)',
};

// Content area capped at 1280px and centered per spec.
export const consoleContentStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 1280,
  margin: '0 auto',
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

// Page title: 24/32/600/-0.015em.
export const consoleHeaderTitleStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 24,
  lineHeight: '32px',
  fontWeight: 600,
  letterSpacing: '-0.015em',
  color: 'var(--c-text)',
};

// Subtitle: 13/20/400.
export const consoleHeaderSubStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 400,
  color: 'var(--c-text-2)',
};

export const consoleTabsRowStyle: CSSProperties = { display: 'flex', gap: 6 };

// design's `tab(on)` helper.
export function consoleTabStyle(on: boolean): CSSProperties {
  return {
    height: 32,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 13px',
    borderRadius: 0,
    fontFamily: 'var(--c-font-sans)',
    fontSize: 13,
    lineHeight: '20px',
    fontWeight: on ? 600 : 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    background: on ? 'var(--c-accent-soft)' : 'transparent',
    border: 'none',
    color: on ? 'var(--c-accent-text)' : 'var(--c-text-2)',
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
  height: 32,
  padding: '0 12px',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--c-text)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line-strong)',
  borderRadius: 0,
  outline: 'none',
};

export const consoleTableStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };

// Table header: 11/16/600 uppercase .08em, sticky, bg-subtle, 36px.
export const consoleTableHeadRowStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  height: 36,
  boxSizing: 'border-box',
  background: 'var(--c-bg-subtle)',
  borderBottom: '1px solid var(--c-line)',
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--c-text-3)',
};

export const consoleColAccountStyle: CSSProperties = { flex: '2 1 200px', minWidth: 150 };
export const consoleColPlanStyle: CSSProperties = { flex: '0 1 110px', minWidth: 88 };
export const consoleColMembersStyle: CSSProperties = { flex: '0 1 84px', minWidth: 66, textAlign: 'right' };
export const consoleColRunsStyle: CSSProperties = { flex: '0 1 86px', minWidth: 70, textAlign: 'right' };
export const consoleColStatusStyle: CSSProperties = { flex: '0 1 100px', minWidth: 86 };

// Body row: 44px min height, 13/20/400.
export const consoleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minHeight: 44,
  boxSizing: 'border-box',
  padding: '12px 0',
  borderBottom: '1px solid var(--c-line)',
  fontFamily: 'var(--c-font-sans)',
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 400,
  color: 'var(--c-text)',
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
  borderRadius: 0,
  background: 'var(--c-surface-2)',
  fontFamily: 'var(--c-font-sans)',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--c-text-2)',
};

export const consoleRowNameColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.35,
  minWidth: 0,
};

export const consoleRowNameStyle: CSSProperties = {
  padding: 0,
  fontFamily: 'var(--c-font-sans)',
  fontSize: 13,
  color: 'var(--c-text)',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleRowKindStyle: CSSProperties = {
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11,
  color: 'var(--c-text-3)',
};

export const consoleRowPlanStyle: CSSProperties = {
  flex: '0 1 110px',
  minWidth: 88,
  fontSize: 13,
  color: 'var(--c-text-2)',
};

// Numeric cell: mono data, tabular-nums, right-aligned.
export const consoleRowNumberStyle: CSSProperties = {
  flex: '0 1 84px',
  minWidth: 66,
  textAlign: 'right',
  fontFamily: 'var(--c-font-mono)',
  fontSize: 12.5,
  lineHeight: '20px',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--c-text-2)',
};

export const consoleEmptyStyle: CSSProperties = {
  padding: '13px 0',
  fontFamily: 'var(--c-font-sans)',
  fontSize: 13,
  color: 'var(--c-text-3)',
};

// "Load more" row below the table, restyled as the spec's table footer row
// (count on the left, pagination control on the right) — same underlying
// pagination pattern, not replaced.
export const consoleLoadMoreRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 4,
  paddingTop: 10,
  borderTop: '1px solid var(--c-line)',
  fontFamily: 'var(--c-font-sans)',
  fontSize: 12.5,
  color: 'var(--c-text-3)',
};

export const consoleLoadMoreErrorStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--c-error)',
};

// Small fixes (2026-09-29): the Runs tab's "Showing the latest 50 runs"
// caption — same muted treatment as consoleEmptyStyle, but a caption sits
// above the table (not inside it as the sole row), so it's a separate
// style rather than reusing consoleEmptyStyle's row padding.
export const consoleRunsCaptionStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--c-text-3)',
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
  fontFamily: 'var(--c-font-sans)',
  fontSize: 13,
};

export const consoleBreadcrumbLinkStyle: CSSProperties = {
  padding: 0,
  fontSize: 13,
  color: 'var(--c-text-3)',
  background: 'transparent',
  border: 'none',
  textDecoration: 'none',
  cursor: 'pointer',
};

export const consoleBreadcrumbSepStyle: CSSProperties = { color: 'var(--c-text-3)' };

export const consoleBreadcrumbCurrentStyle: CSSProperties = { color: 'var(--c-text-2)' };

export const consoleDetailHeaderTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

// Slice 2 addition, not in the design (which folds plan into orgMeta only):
// console-plan.md decision 8 requires plan/limits/usage to be visible on
// this screen, and there's no design slot for it, so a small stat-card row
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
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line)',
};

// Badge/label scale: 11/16/600 uppercase .06em.
export const consoleStatLabelStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--c-text-3)',
};

// KPI value: 28/32/500 -0.02em, mono, tabular-nums.
export const consoleStatValueStyle: CSSProperties = {
  fontFamily: 'var(--c-font-mono)',
  fontSize: 28,
  lineHeight: '32px',
  fontWeight: 500,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--c-text)',
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
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line)',
};

export const consolePlanFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const consolePlanFieldLabelStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--c-text-3)',
};

export const consolePlanInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 160,
  height: 32,
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--c-text)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line-strong)',
  borderRadius: 0,
  outline: 'none',
};

export const consolePlanFormActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

// Subscription model Phase 1: each override field pairs a checkbox
// ("Override" / unchecked = "Clear override", inherit the plan's default)
// with the number input above — this row holds just the checkbox + its
// label, reusing consolePlanInputStyle's sizing conventions for the input
// it sits below.
export const consolePlanOverrideRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

export const consolePlanOverrideLabelStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--c-text-3)',
  cursor: 'pointer',
};

// design's `primary()` helper — used for the plan form's Save button, the
// one write action on this screen.
export const consolePrimaryBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 0,
  background: 'var(--c-accent)',
  border: '1px solid var(--c-accent)',
  color: '#FFFFFF',
  cursor: 'pointer',
};

export const consolePlanFormErrorStyle: CSSProperties = {
  flex: '1 1 100%',
  fontSize: 13,
  color: 'var(--c-error)',
};

export const consolePlanFormWarningStyle: CSSProperties = {
  flex: '1 1 100%',
  fontSize: 13,
  color: 'var(--c-warning)',
};

// Console redesign plan's Slice 7 (Plans page): the warnings list a
// successful PATCH can return (plan.md's "warn, don't block" — these
// render alongside the already-saved row, not as a blocking error). The
// per-row "Edit" button column reuses the existing consoleColActionsStyle
// further below rather than redeclaring it.
export const consoleWarningsListStyle: CSSProperties = {
  flex: '1 1 100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const consoleWarningItemStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--c-warning)',
};

// Section title: 15/22/600 (distinct from the 11/16/600 uppercase
// badge/label scale above — used for in-page subheadings like "Queues").
export const consoleSectionTitleStyle: CSSProperties = {
  fontFamily: 'var(--c-font-sans)',
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 600,
  color: 'var(--c-text)',
};

// Slice 3b (docs/plans/console-plan.md, decisions 1-2, additions 3-6):
// the header action buttons the design has (`isOrgDetail` template) but
// this build deliberately omitted through Slice 2/3a (see
// ConsoleOrgDetailClient's doc comment) — suspend/unsuspend is now real,
// so its one header action is added.
export const consoleHeaderActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

// Danger button: transparent + error border + error text (not a solid
// fill) per the spec's "Danger" button definition.
export const consoleDangerBtnStyle: CSSProperties = {
  flex: 'none',
  height: 32,
  boxSizing: 'border-box',
  padding: '0 14px',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 0,
  background: 'transparent',
  border: '1px solid var(--c-error)',
  color: 'var(--c-error)',
  cursor: 'pointer',
};

// Suspended-state badge shown next to the org name in the header.
export const consoleSuspendedBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 9px',
  borderRadius: 0,
  fontFamily: 'var(--c-font-sans)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  background: 'var(--c-error-bg)',
  border: '1px solid var(--c-error)',
  color: 'var(--c-error)',
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
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-error)',
};

export const consoleSuspendTextareaStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 64,
  padding: '8px 10px',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--c-text)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line-strong)',
  borderRadius: 0,
  outline: 'none',
  resize: 'vertical',
};

export const consoleSuspendMetaStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--c-text-3)',
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
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleRowRoleCellStyle: CSSProperties = {
  flex: '0 1 100px',
  minWidth: 82,
  fontSize: 13,
  color: 'var(--c-text-2)',
};

export const consoleRowJoinedCellStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
  fontFamily: 'var(--c-font-mono)',
  fontSize: 12.5,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--c-text-3)',
};

// Directory row → Org Detail link (Slice 2 addition; the design's row-level
// `open` handler is now a real navigation, not a state toggle).
export const consoleRowLinkStyle: CSSProperties = {
  textDecoration: 'none',
  color: 'inherit',
  cursor: 'pointer',
};

// Subscription Phase 5, Slice 6 (decision 2): Org Detail's Members row now
// has a per-row "Remove" action, so the row itself can no longer be a
// single <Link> (a button nested inside an <a> would double-fire
// navigation on click). This wraps just the member/email/role/joined
// cells in the link instead — same visual layout as consoleRowLinkStyle's
// old full-row link, just scoped to flex: 1 so the actions cell sits
// outside it.
export const consoleRowMemberLinkStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  textDecoration: 'none',
  color: 'inherit',
  cursor: 'pointer',
};

export const consoleColActionsStyle: CSSProperties = { flex: '0 0 90px', textAlign: 'right' };
export const consoleRowActionsCellStyle: CSSProperties = { flex: '0 0 90px', textAlign: 'right' };

export const consoleRowRemoveBtnStyle: CSSProperties = {
  flex: 'none',
  height: 26,
  boxSizing: 'border-box',
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 0,
  background: 'transparent',
  border: '1px solid var(--c-error)',
  color: 'var(--c-error)',
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
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};
export const consoleRowRunDurationCellStyle: CSSProperties = {
  flex: '0 1 90px',
  minWidth: 78,
  textAlign: 'right',
  fontFamily: 'var(--c-font-mono)',
  fontSize: 12.5,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--c-text-2)',
};
export const consoleRowRunErrorCellStyle: CSSProperties = {
  flex: '2 1 240px',
  minWidth: 160,
  fontSize: 13,
  color: 'var(--c-text-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Connectors table (Slice 3d, docs/plans/console-plan.md build order step
// 11). Same flex-basis convention as the Members/Runs tables above. "Type"
// is the connector_id slug (e.g. "mysql"), "Health" is the last-test
// status pill (now the shared StatusPill.tsx component) plus latency when
// available.
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
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};
export const consoleRowConnectorNameCellStyle: CSSProperties = {
  flex: '2 1 200px',
  minWidth: 150,
  fontSize: 13,
  color: 'var(--c-text)',
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
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--c-text-3)',
};
export const consoleRowConnectorCreatedCellStyle: CSSProperties = {
  flex: '0 1 130px',
  minWidth: 106,
  textAlign: 'right',
  fontFamily: 'var(--c-font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};

// Announcements screen (Subscription Phase 5, Slice 3,
// docs/plans/subscription-model.md decision 1). Not in the original design
// file (no announcements concept existed there) — reuses the same card/
// field/button language as the plan-edit and suspend forms above rather
// than inventing a new visual vocabulary.

// Full-width, column-stacked card (unlike consolePlanFormStyle's row-wrap
// layout, this form has too many fields — title, body, severity, audience,
// conditional org/project id, roles, dates — to fit one row).
export const consoleAnnouncementFormStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '16px 18px',
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line)',
};

export const consoleAnnouncementFieldsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
};

// consolePlanInputStyle's fixed 160px width doesn't fit a title field —
// same visual treatment, full width instead.
export const consoleAnnouncementInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 32,
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--c-text)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line-strong)',
  borderRadius: 0,
  outline: 'none',
};

export const consoleAnnouncementRolesRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
};

export const consoleAnnouncementRoleLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

// Live preview (spec: "create with a live preview before publishing") —
// mimics the app banner's own visual shape (see AnnouncementBanner.tsx,
// Slice 4) so what staff sees here is what customers will actually see.
export const consoleAnnouncementPreviewWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export function consoleAnnouncementPreviewStyle(severity: 'info' | 'warning' | 'critical'): CSSProperties {
  const map: Record<'info' | 'warning' | 'critical', [string, string, string]> = {
    info: ['var(--c-text)', 'var(--c-surface-2)', 'var(--c-line-strong)'],
    warning: ['var(--c-warning)', 'var(--c-warning-bg)', 'var(--c-warning)'],
    critical: ['var(--c-error)', 'var(--c-error-bg)', 'var(--c-error)'],
  };
  const [color, background, border] = map[severity];
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '10px 14px',
    borderRadius: 0,
    color,
    background,
    border: `1px solid ${border}`,
  };
}

export const consoleAnnouncementPreviewTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
};

export const consoleAnnouncementPreviewBodyStyle: CSSProperties = {
  fontSize: 13,
  whiteSpace: 'pre-wrap',
};

export const consoleAnnouncementListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const consoleAnnouncementRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 16px',
  borderRadius: 0,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-line)',
};

export const consoleAnnouncementRowHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};

export const consoleAnnouncementRowTitleGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
};

export const consoleAnnouncementRowTitleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--c-text)',
};

export const consoleAnnouncementRowMetaStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--c-text-3)',
};

export const consoleAnnouncementRowBodyStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--c-text-2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
};

import type { CSSProperties } from 'react';

/**
 * Precision Dark redesign — Members & roles (matches
 * designs/nia-design-source/Members.dc.html + MembersStates.dc.html).
 * Dedicated file per the original slice instruction — these pages never
 * add to components/app/styles.ts, matching the precedent already set by
 * components/billing/styles.ts. Generic nxModal* dialog/field primitives
 * from components/app/styles.ts are still reused where the pixel values
 * already match (invite form fields/labels, create-invite CTA).
 */

// ---- Header / hero -------------------------------------------------------

export const nxMembersHeaderRowStyle: CSSProperties = {
  height: 220,
  flexShrink: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxMembersHeaderLeftColStyle: CSSProperties = {
  padding: '28px 40px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  borderRight: '1px solid var(--nx-line)',
};

export const nxMembersEyebrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 16,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxMembersTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const nxMembersH1Style: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 88,
  lineHeight: '80px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

export const nxMembersSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: 'var(--nx-ink-2)',
};

export const nxMembersStatsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
};

export function nxMembersStatCellStyle(highlight: boolean): CSSProperties {
  return {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    borderBottom: '1px solid var(--nx-line-inner)',
    borderRight: '1px solid var(--nx-line-inner)',
    background: highlight ? 'var(--nx-blue-panel)' : 'transparent',
    color: highlight ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink)',
  };
}

export const nxMembersStatLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  opacity: 0.8,
};

export const nxMembersStatValueStyle: CSSProperties = {
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 40,
  lineHeight: '40px',
  fontWeight: 500,
  letterSpacing: '-0.04em',
};

// ---- Body layout ----------------------------------------------------------

export const nxMembersBodyGridStyle: CSSProperties = {
  flexGrow: 1,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
  minHeight: 0,
};

export const nxMembersSectionStyle: CSSProperties = {
  borderRight: '1px solid var(--nx-line)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

export const nxMembersInviteSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

export const nxMembersSectionHeaderStyle: CSSProperties = {
  height: 52,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 24px',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxMembersSectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  letterSpacing: '0.02em',
  fontSize: 22,
  textTransform: 'uppercase',
};

export const nxMembersSectionCountStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

// ---- Member list / rows -----------------------------------------------

const memberGridCols = '44px minmax(0, 1fr) 150px 90px 110px';

export const nxMembersColumnHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: memberGridCols,
  gap: 14,
  height: 38,
  alignItems: 'center',
  padding: '0 24px',
  borderBottom: '1px solid var(--nx-line-inner)',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 13,
  color: 'var(--nx-ink-3)',
  textTransform: 'uppercase',
};

export const nxMembersRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: memberGridCols,
  gap: 14,
  alignItems: 'center',
  minHeight: 68,
  padding: '0 24px',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export function nxMembersAvatarStyle(isSelf: boolean): CSSProperties {
  return {
    width: 44,
    height: 44,
    flexShrink: 0,
    background: isSelf ? 'var(--nx-blue-panel)' : 'var(--nx-raised)',
    color: isSelf ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 800,
    letterSpacing: '0.02em',
    fontSize: 20,
  };
}

export const nxMembersIdentityColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

export const nxMembersNameRowStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxMembersYouTagStyle: CSSProperties = {
  marginLeft: 8,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10.5,
  color: 'var(--nx-blue-panel)',
};

export const nxMembersEmailStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const nxMembersRoleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const nxMembersRoleSelectStyle: CSSProperties = {
  height: 36,
  padding: '0 8px',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  textTransform: 'uppercase',
};

export const nxMembersRoleBadgeStyle: CSSProperties = {
  alignSelf: 'flex-start',
  height: 26,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  background: 'var(--nx-ink)',
  color: 'var(--nx-bg)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

export const nxMembersRolePendingStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  color: 'var(--nx-ink-2)',
  letterSpacing: '0.04em',
};

export const nxMembersRoleErrorStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-danger-text)',
};

export const nxMembersJoinedStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
};

export const nxMembersRemoveBtnStyle: CSSProperties = {
  height: 36,
  border: '1px solid var(--nx-line)',
  background: 'transparent',
  color: 'var(--nx-danger-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

export const nxMembersPermissionNoteStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const nxMembersFooterNoteStyle: CSSProperties = {
  margin: 0,
  padding: '14px 24px',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--nx-ink-3)',
};

// ---- No-permission state (page.tsx) ---------------------------------------

export const nxMembersNoPermissionStyle: CSSProperties = {
  border: '1px solid var(--nx-line)',
  padding: '28px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  backgroundImage: 'radial-gradient(circle, var(--nx-line-inner) 1px, transparent 1.4px)',
  backgroundSize: '6px 6px',
};

export const nxMembersNoPermissionEyebrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxMembersNoPermissionTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 28,
  lineHeight: '32px',
  letterSpacing: '-0.03em',
};

// ---- Invite form ------------------------------------------------------

export const nxMembersInviteFormStyle: CSSProperties = {
  padding: '18px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxMembersInviteFieldGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
};

export const nxMembersInviteFieldColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const nxMembersMonoFieldOverride: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12.5,
};

export const nxMembersInviteHintStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  border: '1px dashed var(--nx-line)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--nx-ink-2)',
};

export function nxMembersInviteSubmitStyle(pending: boolean): CSSProperties {
  return {
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: pending ? 'flex-start' : 'space-between',
    gap: 12,
    padding: '0 20px',
    border: 'none',
    background: pending ? 'var(--nx-blue-tint)' : 'var(--nx-blue-cta)',
    color: pending ? 'var(--nx-blue-soft-text)' : 'var(--nx-blue-cta-text)',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 15,
    cursor: pending ? 'default' : 'pointer',
  };
}

// ---- Invite created card ------------------------------------------------

export const nxMembersCreatedCardStyle: CSSProperties = {
  padding: '20px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  borderBottom: '1px solid var(--nx-line)',
  background: 'var(--nx-blue-panel)',
  color: 'var(--nx-blue-panel-text)',
};

export const nxMembersCreatedHeadingStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  letterSpacing: '0.02em',
  fontSize: 20,
  textTransform: 'uppercase',
};

export const nxMembersLinkRowStyle: CSSProperties = {
  display: 'flex',
  height: 44,
  border: '1px solid var(--nx-bg)',
};

// Fixed literal pair (not theme tokens) — like --nx-logo-tile, this chip
// must stay a light background with dark text regardless of theme, since
// it sits inside the always-purple "invite created" panel.
export const nxMembersLinkChipStyle: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  alignItems: 'center',
  padding: '0 12px',
  background: '#F2F2F2',
  color: '#0A0A0B',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
};

export const nxMembersCopyBtnStyle: CSSProperties = {
  width: 96,
  border: 'none',
  borderLeft: '1px solid var(--nx-bg)',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

// Shown for 2s in place of "Copied" when navigator.clipboard is unavailable
// or writeText() rejects — the link text is selected instead so ⌘C still works.
export const nxMembersCopyFallbackStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxMembersCreatedBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '19px',
};

export const nxMembersCreateAnotherStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--nx-blue-panel-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  textDecoration: 'underline',
  cursor: 'pointer',
};

// ---- Invite list ------------------------------------------------------

export const nxMembersInviteListStyle: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
};

export const nxMembersInviteRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 96px',
  alignItems: 'center',
  minHeight: 60,
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxMembersInviteInfoColStyle: CSSProperties = {
  padding: '10px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
};

export function nxMembersInviteLineStyle(ink: string): CSSProperties {
  return { fontSize: 14, color: ink };
}

export const nxMembersInviteMetaStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxMembersRevokeBtnStyle: CSSProperties = {
  height: '100%',
  border: 'none',
  borderLeft: '1px solid var(--nx-line-inner)',
  background: 'transparent',
  color: 'var(--nx-danger-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

export const nxMembersInviteEmptyStyle: CSSProperties = {
  margin: 0,
  padding: '28px 20px',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 26,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink-2)',
};

// ---- Delete/leave dialog (NxMembersDeleteDialog) --------------------------

export const nxMembersDialogCardStyle: CSSProperties = {
  width: 500,
  maxWidth: '90vw',
  boxSizing: 'border-box',
  border: '1px solid var(--nx-ink-disabled)',
  background: 'var(--nx-bg)',
  display: 'flex',
  flexDirection: 'column',
};

export const nxMembersDialogBodyStyle: CSSProperties = {
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxMembersDialogTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  color: 'var(--nx-danger-text)',
};

export const nxMembersDialogTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 32,
  lineHeight: '34px',
  fontWeight: 500,
  letterSpacing: '-0.035em',
};

export const nxMembersDialogBodyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: '23px',
  color: 'var(--nx-ink-2)',
};

export const nxMembersDialogAlertStyle: CSSProperties = {
  padding: '10px 16px',
  borderBottom: '1px solid var(--nx-line)',
  background: 'var(--nx-danger-tint)',
  fontSize: 13,
  color: 'var(--nx-danger-text)',
};

export const nxMembersDialogFooterStyle: CSSProperties = {
  display: 'flex',
  height: 52,
};

export const nxMembersDialogCancelCellStyle: CSSProperties = {
  width: 120,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  border: 'none',
  borderRight: '1px solid var(--nx-line)',
  background: 'transparent',
  color: 'var(--nx-ink-2)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

export function nxMembersDialogConfirmCellStyle(pending: boolean): CSSProperties {
  return {
    flexGrow: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: pending ? 'flex-start' : 'space-between',
    padding: '0 16px',
    border: 'none',
    background: pending ? 'var(--nx-danger-tint)' : 'var(--nx-danger)',
    color: pending ? 'var(--nx-danger-text)' : 'var(--nx-bg)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: pending ? 'default' : 'pointer',
  };
}

// ---- Project members panel ----------------------------------------------

export const nxProjectMembersPanelStyle: CSSProperties = {
  border: '1px solid var(--nx-line)',
  display: 'flex',
  flexDirection: 'column',
};

export const nxProjectMembersHeaderStyle: CSSProperties = {
  height: 48,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  borderBottom: '1px solid var(--nx-line)',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  letterSpacing: '0.02em',
  fontSize: 18,
  textTransform: 'uppercase',
};

export const nxProjectMembersEmptyStyle: CSSProperties = {
  margin: 0,
  padding: '24px 16px',
  fontSize: 15,
  color: 'var(--nx-ink-2)',
};

export const nxProjectMemberRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export function nxProjectMemberAvatarStyle(): CSSProperties {
  return {
    width: 40,
    height: 40,
    flexShrink: 0,
    background: 'var(--nx-raised)',
    color: 'var(--nx-ink)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 800,
    letterSpacing: '0.02em',
    fontSize: 18,
  };
}

export const nxProjectMemberIdentityColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

export const nxProjectMemberNameStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--nx-ink)',
};

export const nxProjectMemberEmailStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxProjectMemberActionTextStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-danger-text)',
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
};

export const nxProjectMemberNotPermittedStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const nxProjectMembersAddRowStyle: CSSProperties = {
  display: 'flex',
  height: 44,
  borderTop: '1px solid var(--nx-line)',
};

export function nxProjectMembersAddSelectStyle(disabled: boolean): CSSProperties {
  return {
    flexGrow: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    border: 'none',
    background: disabled ? 'var(--nx-raised)' : 'var(--nx-surface)',
    color: disabled ? 'var(--nx-ink-disabled)' : 'var(--nx-ink-2)',
    fontSize: 14,
    appearance: 'none',
  };
}

export function nxProjectMembersAddBtnStyle(disabled: boolean): CSSProperties {
  return {
    width: 90,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: disabled ? 'var(--nx-raised)' : 'var(--nx-ink)',
    color: disabled ? 'var(--nx-ink-disabled)' : 'var(--nx-bg)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 11,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    cursor: disabled ? 'default' : 'pointer',
  };
}

// ---- Accept-invite pages (/invite/[token]) --------------------------------
// Standalone (not wrapped in AuthShell — that shell is shared with
// login/signup's centered light-indigo card, structurally incompatible with
// this design's full-bleed dark panel). Matches MembersStates.dc.html
// section 05 ("already a member" success panel / "invite link problem"
// error panel).

export const nxAcceptInvitePageStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

export function nxAcceptInvitePanelStyle(variant: 'success' | 'error'): CSSProperties {
  return {
    width: 480,
    maxWidth: '90vw',
    minHeight: 360,
    boxSizing: 'border-box',
    padding: 40,
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    border: '1px solid var(--nx-line)',
    background: variant === 'success' ? 'var(--nx-blue-panel)' : 'var(--nx-bg)',
    color: variant === 'success' ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink)',
  };
}

export function nxAcceptInviteEyebrowStyle(variant: 'success' | 'error'): CSSProperties {
  return {
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 700,
    letterSpacing: '0.04em',
    fontSize: 15,
    textTransform: 'uppercase',
    color: variant === 'success' ? 'inherit' : 'var(--nx-danger-text)',
  };
}

export const nxAcceptInviteHeadingStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 64,
  lineHeight: '60px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

export const nxAcceptInviteBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
};

export function nxAcceptInviteCtaStyle(variant: 'success' | 'error'): CSSProperties {
  return {
    marginTop: 'auto',
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    border: variant === 'success' ? 'none' : '1px solid var(--nx-line)',
    background: variant === 'success' ? 'var(--nx-bg)' : 'transparent',
    color: variant === 'success' ? 'var(--nx-ink)' : 'var(--nx-ink)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    textDecoration: 'none',
  };
}

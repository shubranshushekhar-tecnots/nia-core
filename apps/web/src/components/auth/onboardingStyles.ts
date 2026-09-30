import type { CSSProperties } from 'react';

// OnboardingForm's own nx styles file (Precision Dark redesign, Step 8A item
// 1) — deliberately separate from components/auth/styles.ts, which stays
// untouched: that file is AuthShell/LoginForm/SignupForm's shared
// light-indigo [data-auth-theme] theme, still awaiting its own board.
// OnboardingForm no longer renders inside AuthShell; it's a full-bleed
// [data-app-theme] page of its own, same treatment as the accept-invite
// page (components/members/styles.ts's nxAcceptInvite* — see
// SettingsStates.dc.html section 02, "CREATE ORGANIZATION · ONBOARDING
// FORM").

export const nxOnboardingPageStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

export const nxOnboardingHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '24px 32px',
};

// Same condensed-caps wordmark treatment as Sidebar's navWordmarkStyle
// (components/app/styles.ts) — kept as a local copy per this file's
// "own styles file" convention rather than importing across domains.
export const nxOnboardingWordmarkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 15,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
};

export const nxOnboardingMainStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '48px 20px',
};

export const nxOnboardingColumnStyle: CSSProperties = {
  width: 480,
  maxWidth: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

export const nxOnboardingHeadingStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 32,
  fontWeight: 500,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink)',
};

export const nxOnboardingSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '20px',
  color: 'var(--nx-ink-2)',
};

// Field group panel — bordered box housing both fields, per the board's
// IDLE/FIELD ERRORS/PENDING columns (each a single bordered panel, not
// per-field boxes).
export const nxOnboardingPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 16,
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-bg)',
};

export const nxOnboardingFieldGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

export function nxOnboardingLabelStyle(hasError: boolean): CSSProperties {
  return {
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: hasError ? 'var(--nx-danger-text)' : 'var(--nx-ink-2)',
  };
}

export const nxOnboardingNoteStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--nx-ink-3)',
};

// Submit CTA — solid --nx-blue-cta idle, --nx-blue-tint/--nx-blue-soft-text
// pending (same convention as nxMembersInviteSubmitStyle in
// components/members/styles.ts).
export function nxOnboardingSubmitStyle(pending: boolean): CSSProperties {
  return {
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: pending ? 'flex-start' : 'space-between',
    gap: 10,
    padding: '0 16px',
    border: 'none',
    background: pending ? 'var(--nx-blue-tint)' : 'var(--nx-blue-cta)',
    color: pending ? 'var(--nx-blue-soft-text)' : 'var(--nx-blue-cta-text)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: pending ? 'default' : 'pointer',
    width: '100%',
    boxSizing: 'border-box',
  };
}

// Server-error alert — role="alert" card with a left accent bar, per the
// board's PENDING · SERVER ERROR column.
export const nxOnboardingAlertStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid var(--nx-danger)',
  borderLeftWidth: 5,
  background: 'var(--nx-danger-tint)',
  color: 'var(--nx-danger-text)',
  fontSize: 13,
  lineHeight: '18px',
};

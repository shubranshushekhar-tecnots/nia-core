import type { CSSProperties } from 'react';

// Precision Dark redesign (Step 8B) — Auth screens (/login, /signup, the
// 2FA step). Ported from designs/nia-design-source/Auth.dc.html +
// AuthStates.dc.html. Regular 44px text fields (email, full name, the
// 2FA-free case) reuse app/styles.ts's nxModalFieldStyle/nxModalErrorStyle
// directly — pixel-identical to the design's own `.nx-field` spec — same
// precedent as OnboardingForm.tsx importing across domains for exactly
// this reason. The general-error alert bar reuses onboardingStyles.ts's
// nxOnboardingAlertStyle (also pixel-identical). This file only holds
// what's actually new here: the shell chrome, the hero/heading column,
// and the two field variants `.nx-field` doesn't cover (password-with-
// eye-button, the 2FA mono code input).
//
// The handful of properties that change below 960px (per AuthStates
// .dc.html's "BELOW 960PX" note) can't be expressed by CSSProperties
// objects — those live as the `.nx-auth-*` classes in packages/ui/src/
// theme.css instead (same pattern as that file's `.hl-container`/
// `.hl-lead`), applied via className alongside these inline styles.

export const nxAuthRootStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  gridTemplateRows: '64px minmax(0, 1fr)',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-ui)',
};

export const nxAuthHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxAuthLogoCellStyle: CSSProperties = {
  width: 64,
  height: 64,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--nx-line)',
};

export const nxAuthWordmarkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  padding: '0 16px',
};

export const nxAuthThemeToggleStyle: CSSProperties = {
  marginLeft: 'auto',
  width: 64,
  height: 64,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderLeft: '1px solid var(--nx-line)',
  cursor: 'pointer',
};

// Left hero column — kicker/heading/subtitle moved out of the card and
// into here (same strings/conditions, just relocated). `.nx-auth-hero`
// (theme.css) carries the responsive padding + 200px-band collapse;
// `.nx-halftone` (already global) is the dot-grid background — the design's
// own directional mask-image fade on that background is dropped as a
// low-risk simplification.
export const nxAuthHeroStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: 20,
  overflow: 'hidden',
  borderRight: '1px solid var(--nx-line)',
};

export const nxAuthKickerStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 16,
  color: 'var(--nx-ink-2)',
  textTransform: 'uppercase',
};

// Font-size/line-height are responsive (128px/112px desktop, 64px below
// 960px) — see `.nx-auth-heading` in theme.css.
export const nxAuthHeadingStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontWeight: 500,
  letterSpacing: '-0.06em',
};

export const nxAuthSubtitleStyle: CSSProperties = {
  margin: 0,
  maxWidth: 560,
  fontSize: 18,
  lineHeight: '27px',
  color: 'var(--nx-ink-2)',
};

export const nxAuthFormColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

// Padding is responsive (40px desktop, 24px below 960px) — see
// `.nx-auth-form-pad` in theme.css.
export const nxAuthFormStyle: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 18,
};

export const nxAuthFieldGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

export function nxAuthLabelStyle(hasError: boolean): CSSProperties {
  return {
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 700,
    fontSize: 14,
    color: hasError ? 'var(--nx-danger-text)' : 'var(--nx-ink-2)',
    textTransform: 'uppercase',
  };
}

export const nxAuthPasswordRowStyle: CSSProperties = { display: 'flex' };

export function nxAuthPasswordFieldStyle(hasError: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    boxSizing: 'border-box',
    height: 44,
    padding: '0 12px',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 15,
    color: 'var(--nx-ink)',
    background: 'var(--nx-surface)',
    border: `1px solid ${hasError ? 'var(--nx-danger)' : 'var(--nx-line)'}`,
    borderRight: 'none',
    outline: 'none',
  };
}

export const nxAuthEyeBtnStyle: CSSProperties = {
  width: 48,
  height: 44,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink-2)',
  cursor: 'pointer',
};

// 2FA code input — mono, widely tracked, centered. AuthStates.dc.html's
// small-card mockups show 60px here vs. Auth.dc.html's full board showing
// 64px; picked 60px (the states board is the more detailed reference for
// this field) — noted in the final report.
export function nxAuthCodeFieldStyle(hasError: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    height: 60,
    padding: '0 16px',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 24,
    letterSpacing: '0.4em',
    textAlign: 'center',
    color: 'var(--nx-ink)',
    background: 'var(--nx-surface)',
    border: `1px solid ${hasError ? 'var(--nx-danger)' : 'var(--nx-line)'}`,
    outline: 'none',
  };
}

export const nxAuthNoteStyle: CSSProperties = { fontSize: 12, color: 'var(--nx-ink-3)' };

// Email Phase 3 — /request-access's longer form adds a multi-line field
// (use case) and a checkbox group (data sources) that the shorter
// login/signup forms never needed. Textarea mirrors nxModalFieldStyle's
// look (app/styles.ts) but with a fixed height instead of 44px fixed.
export function nxAuthTextareaStyle(hasError: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 88,
    padding: '10px 12px',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 15,
    color: 'var(--nx-ink)',
    background: 'var(--nx-surface)',
    border: `1px solid ${hasError ? 'var(--nx-danger)' : 'var(--nx-line)'}`,
    outline: 'none',
    resize: 'vertical',
  };
}

export const nxAuthCheckboxGroupStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px 16px',
};

export const nxAuthCheckboxLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 14,
  color: 'var(--nx-ink-2)',
  cursor: 'pointer',
};

export const nxAuthToggleLinkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textDecoration: 'underline',
  color: 'var(--nx-ink-2)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

// Submit CTA — idle bg --nx-blue-cta, busy the literal #2A2560 (no --nx-*
// token matches this hex; it also recurs identically in RenameDialog's
// design spec, so it reads as an intentional fixed "busy CTA" value, not
// a mapping miss). The arrow icon is rendered by the caller OUTSIDE this
// style's content, always visible regardless of pending — unlike
// nxModalPrimaryCellStyle's buttons, which hide their arrow while pending.
export function nxAuthSubmitBtnStyle(pending: boolean): CSSProperties {
  return {
    marginTop: 8,
    height: 56,
    boxSizing: 'border-box',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '0 20px',
    border: 'none',
    background: pending ? '#2A2560' : 'var(--nx-blue-cta)',
    color: '#FFFFFF',
    fontFamily: 'var(--nx-font-ui)',
    fontSize: 16,
    fontWeight: 500,
    cursor: pending ? 'default' : 'pointer',
  };
}

export const nxAuthSubmitLabelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };

// Footer — a single full-width 64px clickable cell (the whole row is the
// link), not the old centered two-line footer.
export const nxAuthFooterCellStyle: CSSProperties = {
  height: 64,
  flex: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 40px',
  borderTop: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-2)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 15,
  textDecoration: 'none',
};

export const nxAuthFooterLinkTextStyle: CSSProperties = { color: 'var(--nx-ink)' };

import type { CSSProperties } from 'react';

/**
 * Settings (Phase 1). Dedicated file per the precedent set by
 * components/billing/styles.ts and components/members/styles.ts — pages
 * never add to components/app/styles.ts. Generic nxModal* form-field
 * primitives (label/input/error) from components/app/styles.ts are reused
 * directly for the Profile/Organization forms since the pixel values
 * already match. Matches designs/nia-design-source/Settings.dc.html +
 * SettingsStates.dc.html (+ Light variants): success alerts use the blue
 * rule (--nx-blue-panel border / --nx-blue-tint background), never green;
 * field/server errors use the danger rule, same as everywhere else in the
 * app.
 */

// ---- Header ---------------------------------------------------------------

export const nxSettingsHeaderRowStyle: CSSProperties = {
  padding: '28px 40px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxSettingsEyebrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 16,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxSettingsH1Style: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 64,
  lineHeight: '60px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

export const nxSettingsSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: 'var(--nx-ink-2)',
};

// ---- Body / sections --------------------------------------------------

export const nxSettingsBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 720,
};

export const nxSettingsSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '24px 40px',
  gap: 16,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxSettingsSectionDangerStyle: CSSProperties = {
  ...nxSettingsSectionStyle,
  borderBottom: 'none',
};

export const nxSettingsSectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  letterSpacing: '0.02em',
  fontSize: 20,
  textTransform: 'uppercase',
};

export const nxSettingsSectionTitleDangerStyle: CSSProperties = {
  ...nxSettingsSectionTitleStyle,
  color: 'var(--nx-danger-text)',
};

export const nxSettingsSectionHintStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '19px',
  color: 'var(--nx-ink-3)',
};

// ---- Form fields (Profile / Organization) ----------------------------
// nxModalLabelStyle / nxModalFieldStyle / nxModalErrorStyle are reused
// directly from components/app/styles.ts — only the row layout is local.

export const nxSettingsFormStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const nxSettingsFieldRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const nxSettingsFieldGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 14,
};

export const nxSettingsReadOnlyValueStyle: CSSProperties = {
  height: 44,
  boxSizing: 'border-box',
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 15,
  color: 'var(--nx-ink-2)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line-inner)',
  borderRadius: 'var(--nx-radius)',
};

export function nxSettingsSaveBtnStyle(pending: boolean): CSSProperties {
  return {
    alignSelf: 'flex-start',
    height: 40,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 16px',
    border: 'none',
    background: pending ? 'var(--nx-blue-tint)' : 'var(--nx-blue-cta)',
    color: pending ? 'var(--nx-blue-soft-text)' : 'var(--nx-blue-cta-text)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: pending ? 'default' : 'pointer',
  };
}

// "Saved" success banner — blue rule per SettingsStates.dc.html ("Success
// uses the blue rule, not green, consistent with the rest of the system").
export const nxSettingsSavedAlertStyle: CSSProperties = {
  padding: '10px 16px',
  border: '1px solid var(--nx-blue-panel)',
  background: 'var(--nx-blue-tint)',
  color: 'var(--nx-blue-soft-text)',
  fontSize: 13,
};

export const nxSettingsErrorAlertStyle: CSSProperties = {
  padding: '10px 16px',
  border: '1px solid var(--nx-danger)',
  background: 'var(--nx-danger-tint)',
  color: 'var(--nx-danger-text)',
  fontSize: 13,
};

// ---- Link rows (Members & roles / Billing) -----------------------------

export const nxSettingsLinkRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 56,
  padding: '0 16px',
  border: '1px solid var(--nx-line)',
  color: 'inherit',
  textDecoration: 'none',
};

export const nxSettingsLinkRowLabelStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--nx-ink)',
};

export const nxSettingsLinkRowArrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 14,
  color: 'var(--nx-ink-3)',
};

// ---- Appearance — large 3-card picker (next-themes' shared `useTheme()`
// state) -------------------------------------------------------------

export const nxSettingsAppearanceGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 12,
};

export function nxSettingsAppearanceCardStyle(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    border: `1px solid ${selected ? 'var(--nx-blue-panel)' : 'var(--nx-line)'}`,
    background: selected ? 'var(--nx-blue-tint)' : 'var(--nx-surface)',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

export function nxSettingsAppearanceSwatchStyle(background: string): CSSProperties {
  return {
    height: 64,
    border: '1px solid var(--nx-line-inner)',
    background,
  };
}

export function nxSettingsAppearanceLabelStyle(selected: boolean): CSSProperties {
  return {
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: selected ? 'var(--nx-blue-soft-text)' : 'var(--nx-ink-2)',
  };
}

export const nxSettingsAppearanceHelperStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

// ---- Danger zone --------------------------------------------------------

export const nxSettingsDangerBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  height: 40,
  padding: '0 16px',
  border: '1px solid var(--nx-danger)',
  background: 'transparent',
  color: 'var(--nx-danger-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

// ---- No-org state -------------------------------------------------------

export const nxSettingsNoOrgTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: 'var(--nx-ink-3)',
};

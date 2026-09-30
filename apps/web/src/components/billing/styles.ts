import type { CSSProperties } from 'react';

/**
 * Subscription model Phase 1. Billing-only styles — dedicated file so the
 * billing page's usage cards don't need to add anything to
 * components/app/styles.ts (shared app-shell styles used by Connections,
 * Dashboard, etc. — not touched by this build).
 */

export const billingUsageGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 16,
  maxWidth: 640,
};

export const billingUsageCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '20px 20px 18px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export const billingUsageLabelStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-3)',
};

export const billingUsageValueStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--text)',
};

export const billingUsageMeterTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--line-200)',
  overflow: 'hidden',
};

export const billingUsageMeterFillStyle: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--acc)',
};

// Subscription Phase 4, Slice 2 — upgrade section (interval toggle,
// downgrade warning banner, upgrade CTA, and the processing/redirect page).

export const billingIntervalToggleStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 3,
  borderRadius: 9,
  background: 'var(--surface-2)',
  border: '1px solid var(--line)',
};

export function billingIntervalOptionStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 7,
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-3)',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
  };
}

export const billingWarningBannerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'var(--warn-bg, rgba(234,179,8,0.1))',
  border: '1px solid var(--warn-border, rgba(234,179,8,0.35))',
  fontSize: 12.5,
  color: 'var(--text-2)',
  maxWidth: 460,
};

// Subscription Phase 3, Slice 4 — 100%-of-limit banner (rows/Copilot hard
// stop), distinct from billingWarningBannerStyle's 80% amber warning: a
// danger-colored variant so a blocked state reads differently from a
// heads-up one.
export const billingBlockedBannerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'var(--danger-bg, rgba(217,45,32,0.1))',
  border: '1px solid var(--danger-border, rgba(217,45,32,0.35))',
  fontSize: 12.5,
  color: 'var(--text-2)',
  maxWidth: 460,
};

export const billingErrorTextStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--danger, #d92d20)',
};

export const billingProcessingCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  padding: '32px 28px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  maxWidth: 460,
};

// ---------------------------------------------------------------------
// Precision Dark redesign (Step 7 — Billing). New nx-prefixed styles,
// pixel-matched to designs/nia-design-source/Billing.dc.html /
// BillingStates.dc.html (+ Light variants). Everything above this point
// is the pre-redesign implementation, left untouched — only
// billing/page.tsx, billing/processing/[id]/page.tsx, UpgradeSection.tsx
// and ProcessingStatus.tsx read the styles below.
// ---------------------------------------------------------------------

// Header — 220px grid, title column (1.5fr) + usage-meters column (1fr),
// same divider convention as Connections' nxConnPageHeaderRowStyle.
export const nxBillingHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
  minHeight: 220,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxBillingHeaderLeftColStyle: CSSProperties = {
  padding: '28px 40px 32px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 14,
  borderRight: '1px solid var(--nx-line)',
};

export const nxBillingPageTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxBillingTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const nxBillingPageTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 96,
  lineHeight: '86px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
  color: 'var(--nx-ink)',
};

export const nxBillingPageSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
  color: 'var(--nx-ink-2)',
};

// Right column — Workflows/Projects usage-meter rows, stacked, divided
// by an inner --nx-line-inner border.
export const nxBillingHeaderRightColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

export const nxBillingMeterRowStyle = (last: boolean): CSSProperties => ({
  flex: 1,
  padding: '18px 28px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 10,
  borderBottom: last ? 'none' : '1px solid var(--nx-line-inner)',
});

export const nxBillingMeterLabelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
};

export const nxBillingMeterLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxBillingMeterValueStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--nx-ink)',
};

export const nxBillingMeterTrackStyle: CSSProperties = {
  height: 4,
  background: 'var(--nx-line-inner)',
  overflow: 'hidden',
};

export const nxBillingMeterFillStyle = (pct: number, atLimit: boolean): CSSProperties => ({
  height: 4,
  width: `${pct}%`,
  background: atLimit ? 'var(--nx-warn)' : 'var(--nx-blue-panel)',
});

// Unlimited plans render a full-width striped fill instead of a % bar —
// BillingStates.dc.html's "unlimited" usage-card variant.
export const nxBillingMeterUnlimitedFillStyle: CSSProperties = {
  height: 4,
  width: '100%',
  background:
    'repeating-linear-gradient(45deg, var(--nx-ink-3) 0, var(--nx-ink-3) 1px, transparent 1px, transparent 5px)',
  opacity: 0.5,
};

export const nxBillingLimitTextStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-warn)',
};

// Rows/Copilot usage cards — same meter visual language as the header
// rows, laid out as a bordered 2-up grid below it (BillingStates'
// "usage card" under-limit/at-limit/unlimited states).
export const nxBillingUsageCardsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxBillingUsageCardCellStyle = (last: boolean): CSSProperties => ({
  padding: '20px 40px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  borderRight: last ? 'none' : '1px solid var(--nx-line)',
});

// 80%-warning / 100%-blocked usage banners — colored left border + plain
// text, replacing the old rounded/tinted-box treatment.
export const nxBillingBannerStyle = (kind: 'warn' | 'blocked'): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '14px 16px',
  borderLeft: `3px solid ${kind === 'blocked' ? 'var(--nx-danger)' : 'var(--nx-warn)'}`,
  background: kind === 'blocked' ? 'var(--nx-danger-tint)' : 'transparent',
  fontSize: 12.5,
  color: 'var(--nx-ink-2)',
  maxWidth: 460,
});

export const nxBillingBannerStrongStyle: CSSProperties = {
  color: 'var(--nx-ink)',
  fontWeight: 600,
};

export const nxBillingBannersColStyle: CSSProperties = {
  padding: '20px 40px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

// Upgrade section — single column only: the design's blue "WHAT CHANGES"
// Free-vs-Pro comparison panel needs the Pro plan's numeric limits, which
// no endpoint returns to the web app today, so it isn't built (see the
// Step 7 report's skip list).
export const nxBillingUpgradeSectionStyle: CSSProperties = {
  padding: '40px',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  maxWidth: 520,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxBillingUpgradeTagStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-blue-panel)',
};

export const nxBillingUpgradeTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 44,
  lineHeight: '46px',
  fontWeight: 500,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink)',
};

export const nxBillingMutedTextStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: '20px',
  color: 'var(--nx-ink-2)',
};

export const nxBillingIntervalToggleStyle: CSSProperties = {
  display: 'inline-flex',
  width: 280,
  height: 44,
  boxSizing: 'border-box',
  border: '1px solid var(--nx-line)',
};

export const nxBillingIntervalOptionStyle = (active: boolean, disabled: boolean): CSSProperties => ({
  flex: 1,
  height: '100%',
  border: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: disabled ? 'not-allowed' : 'pointer',
  background: active ? 'var(--nx-ink)' : 'transparent',
  color: active ? 'var(--nx-bg)' : disabled ? 'var(--nx-ink-disabled)' : 'var(--nx-ink-2)',
});

export const nxBillingErrorTextStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-danger-text)',
};

export const nxBillingCtaBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  height: 60,
  width: '100%',
  maxWidth: 320,
  boxSizing: 'border-box',
  padding: '0 22px',
  border: 'none',
  background: 'var(--nx-blue-cta)',
  color: 'var(--nx-blue-cta-text)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 15,
  fontWeight: 500,
  cursor: 'pointer',
};

// Payments-off CTA — full-width 52px disabled cell (PAYMENTS_ENABLED=false
// keeps priority over the design; no design state exists for this, styled
// per the Step 7 spec directly). No .nx-wipe hover — it's inert.
export const nxBillingComingSoonRowStyle: CSSProperties = {
  height: 52,
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  background: 'var(--nx-raised)',
  border: 'none',
  maxWidth: 520,
  margin: '40px',
};

export const nxBillingComingSoonTextStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxBillingSoonChipStyle: CSSProperties = {
  padding: '2px 6px',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink-3)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

// Org-actor "checkout not supported" card — BillingStates' flat card
// treatment (distinct from the payments-off cell above: this is its own
// outer bordered card, not a panel cell).
export const nxBillingOrgCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 460,
  margin: '40px',
  border: '1px solid var(--nx-line)',
};

export const nxBillingOrgCardBodyStyle: CSSProperties = {
  padding: '24px 24px 20px',
  fontSize: 13.5,
  lineHeight: '20px',
  color: 'var(--nx-ink-2)',
};

export const nxBillingOrgCardFooterStyle: CSSProperties = {
  height: 52,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 20px',
  borderTop: '1px solid var(--nx-line)',
};

export const nxBillingOrgCardBtnTextStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-disabled)',
};

// Processing page — eyebrow + giant H1 left column, dynamic-background
// status card right column.
export const nxBillingProcessingRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  minHeight: 280,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxBillingProcessingLeftColStyle: CSSProperties = {
  padding: '28px 40px 32px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 14,
  borderRight: '1px solid var(--nx-line)',
};

export const nxBillingProcessingTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 96,
  lineHeight: '86px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
  color: 'var(--nx-ink)',
};

export type NxBillingStatusTone = 'neutral' | 'warn' | 'danger' | 'active';

export const nxBillingStatusCardStyle = (active: boolean): CSSProperties => ({
  padding: '32px 28px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 20,
  background: active ? 'var(--nx-blue-panel)' : 'var(--nx-bg)',
  color: active ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink)',
});

export const nxBillingStatusTagStyle = (tone: NxBillingStatusTone): CSSProperties => ({
  display: 'inline-flex',
  width: 'fit-content',
  padding: '3px 8px',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  background:
    tone === 'active' ? 'var(--nx-blue-panel-text)' : tone === 'warn' ? 'var(--nx-warn)' : tone === 'danger' ? 'var(--nx-danger)' : 'var(--nx-raised)',
  color: tone === 'active' ? 'var(--nx-blue-panel)' : tone === 'warn' || tone === 'danger' ? 'var(--nx-bg)' : 'var(--nx-ink-2)',
});

export const nxBillingStatusBodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: '21px',
};

export const nxBillingReopenLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 0,
  background: 'transparent',
  border: 'none',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  color: 'inherit',
};

export const nxBillingBackBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '10px 16px',
  background: 'transparent',
  border: '1px solid currentColor',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  color: 'inherit',
};

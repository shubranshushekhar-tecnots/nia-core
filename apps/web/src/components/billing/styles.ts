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

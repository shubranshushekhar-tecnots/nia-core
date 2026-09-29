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

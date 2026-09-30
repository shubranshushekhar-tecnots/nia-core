'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCheckout, getUpgradePreview, type UpgradePreview } from '@/lib/api/billingClient';
import {
  nxBillingBannerStrongStyle,
  nxBillingBannerStyle,
  nxBillingCtaBtnStyle,
  nxBillingErrorTextStyle,
  nxBillingIntervalOptionStyle,
  nxBillingIntervalToggleStyle,
  nxBillingMutedTextStyle,
  nxBillingUpgradeTagStyle,
  nxBillingUpgradeTitleStyle,
} from './styles';

const WARNING_LABEL: Record<UpgradePreview['warnings'][number]['field'], string> = {
  projectLimit: 'projects',
  workflowLimit: 'workflows',
};

function formatLimit(n: number | null): string {
  return n === null ? 'unlimited' : String(n);
}

/**
 * Subscription Phase 4, Slice 2 — replaces the old disabled "Upgrade plan
 * — coming soon" button. Individual-only (org actors never reach this
 * component — billing/page.tsx only renders it when user.org is null, same
 * gate apps/api/src/routes/billing.ts's checkout route enforces
 * server-side with its own 409 ORG_BILLING_NOT_SUPPORTED).
 *
 * Fetches GET /billing/upgrade-preview on mount to decide which intervals
 * are available and whether to show a pre-checkout downgrade warning (e.g.
 * Legacy's unlimited projects -> Pro's 5). POST /billing/checkout creates
 * the Razorpay subscription server-side and returns Razorpay's own hosted
 * checkout page (`short_url`) — this redirects the browser there directly
 * rather than embedding Checkout.js (speed rule). Plan changes themselves
 * never happen here — only on the webhook (routes/billingWebhook.ts).
 */
export default function UpgradeSection() {
  const router = useRouter();
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUpgradePreview()
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setInterval(data.monthlyAvailable ? 'monthly' : 'yearly');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load upgrade options.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <span style={nxBillingMutedTextStyle}>Loading upgrade options…</span>;
  }

  if (error && !preview) {
    return <span style={nxBillingErrorTextStyle}>{error}</span>;
  }

  if (!preview) return null;

  if (preview.currentPlanId === 'pro') {
    return <span style={nxBillingMutedTextStyle}>You're already on the Pro plan.</span>;
  }

  async function handleUpgrade() {
    setSubmitting(true);
    setError(null);
    try {
      const { checkoutUrl, subscriptionId } = await createCheckout(interval);
      router.push(`/app/billing/processing/${subscriptionId}?checkoutUrl=${encodeURIComponent(checkoutUrl)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout.');
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <span style={nxBillingUpgradeTagStyle}>Upgrade</span>
      <h2 style={nxBillingUpgradeTitleStyle}>
        Upgrade from {preview.currentPlanName} to {preview.proPlanName}.
      </h2>

      <div style={nxBillingIntervalToggleStyle}>
        <button
          type="button"
          disabled={!preview.monthlyAvailable}
          style={nxBillingIntervalOptionStyle(interval === 'monthly', !preview.monthlyAvailable)}
          onClick={() => setInterval('monthly')}
        >
          Monthly
        </button>
        <button
          type="button"
          disabled={!preview.yearlyAvailable}
          style={nxBillingIntervalOptionStyle(interval === 'yearly', !preview.yearlyAvailable)}
          onClick={() => setInterval('yearly')}
        >
          Yearly
        </button>
      </div>

      {preview.warnings.length > 0 && (
        <div style={nxBillingBannerStyle('warn')}>
          <span style={nxBillingBannerStrongStyle}>Pro has lower limits on your current usage:</span>
          {preview.warnings.map((w) => (
            <span key={w.field}>
              {WARNING_LABEL[w.field]}: {formatLimit(w.current)} → {formatLimit(w.upgraded)}
            </span>
          ))}
        </div>
      )}

      {error && <span style={nxBillingErrorTextStyle}>{error}</span>}

      <button type="button" style={nxBillingCtaBtnStyle} disabled={submitting} onClick={handleUpgrade}>
        {submitting ? 'Starting checkout…' : `Upgrade to ${preview.proPlanName}`}
      </button>
    </div>
  );
}

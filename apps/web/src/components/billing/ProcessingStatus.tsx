'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSubscriptionStatus } from '@/lib/api/billingClient';
import { billingProcessingCardStyle } from './styles';

const POLL_INTERVAL_MS = 2000;

const STATUS_COPY: Record<string, string> = {
  incomplete: 'Payment processing…',
  active: 'Payment confirmed — you\u2019re on the Pro plan.',
  past_due: 'Payment is past due.',
  canceled: 'This subscription was canceled.',
};

/**
 * Subscription Phase 4, Slice 2 — shown at /app/billing/processing/:id
 * after UpgradeSection redirects here with the new subscription's id.
 * Plan changes only ever happen on the webhook (routes/billingWebhook.ts),
 * never here — this component is read-only, it just polls
 * GET /billing/subscriptions/:id until status leaves 'incomplete'.
 *
 * `checkoutUrl` (Razorpay's own hosted checkout page) is handed off to in
 * a new tab on mount rather than a full-page navigation, so this tab keeps
 * polling — in production the subscription's redirect-back destination is
 * configured once in the Razorpay Dashboard's hosted-checkout settings to
 * point back at this same URL, but polling here means that redirect isn't
 * load-bearing for the status to update.
 */
export default function ProcessingStatus({ subscriptionId, checkoutUrl }: { subscriptionId: string; checkoutUrl: string | null }) {
  const router = useRouter();
  const [status, setStatus] = useState('incomplete');
  const [error, setError] = useState<string | null>(null);
  const openedCheckout = useRef(false);

  useEffect(() => {
    if (checkoutUrl && !openedCheckout.current) {
      openedCheckout.current = true;
      window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
    }
  }, [checkoutUrl]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const data = await getSubscriptionStatus(subscriptionId);
        if (cancelled) return;
        setStatus(data.status);
        if (data.status === 'incomplete') {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to check subscription status.');
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [subscriptionId]);

  return (
    <div style={billingProcessingCardStyle}>
      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
        {STATUS_COPY[status] ?? status}
      </span>
      {status === 'incomplete' && (
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          Complete the payment in the Razorpay tab we opened. This page updates automatically once it's confirmed.
        </span>
      )}
      {error && <span style={{ fontSize: 12.5, color: 'var(--danger, #d92d20)' }}>{error}</span>}
      <button
        type="button"
        style={{ fontSize: 12.5, color: 'var(--text-3)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        onClick={() => router.push('/app/billing')}
      >
        ← Back to billing
      </button>
    </div>
  );
}

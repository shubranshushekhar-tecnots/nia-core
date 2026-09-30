import { ensureBearerToken } from '@/lib/auth/browserSession';

/**
 * Subscription Phase 4, Slice 2 — browser-side calls for apps/api's
 * /billing/* routes (routes/billing.ts). Same same-origin-proxy target and
 * Bearer-only auth convention as connectionsClient.ts — see that file's
 * header comment for the full rationale.
 */

export class BillingApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BillingApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await ensureBearerToken();
  if (!token) throw new BillingApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${token}` };
}

async function throwFromResponse(res: Response): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new BillingApiError(
    res.status,
    body?.error?.code ?? 'UNKNOWN',
    body?.error?.message ?? res.statusText,
    body?.error?.details,
  );
}

export type UpgradeWarning = {
  field: 'projectLimit' | 'workflowLimit';
  current: number | null;
  upgraded: number | null;
};

export type UpgradePreview = {
  currentPlanId: string;
  currentPlanName: string;
  proPlanName: string;
  monthlyAvailable: boolean;
  yearlyAvailable: boolean;
  warnings: UpgradeWarning[];
};

export async function getUpgradePreview(): Promise<UpgradePreview> {
  const res = await fetch('/api/backend/billing/upgrade-preview', {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) return throwFromResponse(res);
  return res.json() as Promise<UpgradePreview>;
}

export async function createCheckout(interval: 'monthly' | 'yearly'): Promise<{ checkoutUrl: string; subscriptionId: string }> {
  const res = await fetch('/api/backend/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ interval }),
  });
  if (!res.ok) return throwFromResponse(res);
  return res.json() as Promise<{ checkoutUrl: string; subscriptionId: string }>;
}

export async function getSubscriptionStatus(subscriptionId: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`/api/backend/billing/subscriptions/${subscriptionId}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) return throwFromResponse(res);
  return res.json() as Promise<{ id: string; status: string }>;
}

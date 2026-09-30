'use server';

import { apiFetchServer, ApiError } from '@/lib/api/server';

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1): AnnouncementBanner's dismiss ("x") button calls this — same
 * useTransition-driven, ok/error mutation shape as
 * lib/console/actions.ts's suspendOrgAction. The banner never renders this
 * control for a critical-severity announcement, so the FORBIDDEN error
 * apps/api's /announcements/:id/dismiss can return (RLS rejects a critical
 * dismissal) is only ever a defensive fallback here, not an expected path.
 */
export async function dismissAnnouncementAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await apiFetchServer<{ status: string }>(`/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't dismiss this announcement. Try again." };
  }
}

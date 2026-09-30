import { apiFetchServer } from './server';

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). Thin wrapper over apiFetchServer for apps/api's customer-facing
 * /announcements/* routes — same pattern as consoleServer.ts, but reading
 * the caller's own targeted announcements rather than the staff catalog.
 */
export type ActiveAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
};

export async function getActiveAnnouncements(): Promise<ActiveAnnouncement[]> {
  const { announcements } = await apiFetchServer<{ announcements: ActiveAnnouncement[] }>('/announcements/active');
  return announcements;
}

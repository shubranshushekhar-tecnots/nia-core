'use client';

import { useState, useTransition } from 'react';
import type { ActiveAnnouncement } from '@/lib/api/announcementsServer';
import { dismissAnnouncementAction } from '@/lib/announcements/actions';
import {
  announcementBannerBodyStyle,
  announcementBannerDismissStyle,
  announcementBannerRowStyle,
  announcementBannerStackStyle,
  announcementBannerTextStyle,
  announcementBannerTitleStyle,
} from './announcementBannerStyles';

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). Rendered by AppShell, right below topBar, for every /app/* page.
 * AppShell already fetched the caller's own targeted, non-dismissed
 * announcements (getActiveAnnouncements, RLS-scoped, max 3, critical
 * first) — this component only owns the dismiss interaction and the local
 * "remove it from view immediately" optimistic update. Critical
 * announcements never get a dismiss button: RLS
 * (announcement_dismissals_insert_own's WITH CHECK) would reject the
 * insert anyway, so there's no point offering a control that can't work.
 */
export default function AnnouncementBanner({ announcements }: { announcements: ActiveAnnouncement[] }) {
  const [visible, setVisible] = useState(announcements);
  const [, startTransition] = useTransition();

  if (visible.length === 0) return null;

  function handleDismiss(id: string) {
    setVisible((prev) => prev.filter((a) => a.id !== id));
    startTransition(async () => {
      const result = await dismissAnnouncementAction(id);
      if (!result.ok) {
        // RLS refused it (e.g. it became critical or ended between render
        // and click) — nothing sensible to show the user for a control
        // they've already dismissed visually; next page load will resolve
        // to the server's real state either way.
      }
    });
  }

  return (
    <div style={announcementBannerStackStyle}>
      {visible.map((a) => (
        <div key={a.id} style={announcementBannerRowStyle(a.severity)}>
          <div style={announcementBannerTextStyle}>
            <span style={announcementBannerTitleStyle}>{a.title}</span>
            <span style={announcementBannerBodyStyle}>{a.body}</span>
          </div>
          {a.severity !== 'critical' && (
            <button
              type="button"
              aria-label="Dismiss"
              style={announcementBannerDismissStyle}
              onClick={() => handleDismiss(a.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

import type { ReactNode } from 'react';
import { shellBodyStyle, shellRootStyle } from './styles';
import { getActiveAnnouncements } from '@/lib/api/announcementsServer';
import AnnouncementBanner from './AnnouncementBanner';

// App shell is light-only (matches the design — the Midnight Navy dark
// theme is scoped in packages/ui/src/theme.css but intentionally not
// wired up as a user-facing toggle here). `data-om-theme="light"` selects
// the [data-app-theme][data-om-theme='light'] token scope.
//
// Layout mirrors the design exactly: a full-width TopBar strip (brand +
// org switcher + search/notifications/avatar) sits above a row containing
// the Sidebar and the page content — the TopBar is not scoped to just the
// content column.
//
// Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md,
// decision 1): async now — fetches the caller's own targeted announcements
// itself rather than requiring all 8 page.tsx call sites to fetch and pass
// them down. getActiveAnnouncements ultimately calls requireUser() (React
// cache()), so this adds no extra DB round trip beyond what each page
// already pays for its own requireUser()/requireUserWithOrg() call in the
// same request.
export default async function AppShell({ topBar, children }: { topBar: ReactNode; children: ReactNode }) {
  const announcements = await getActiveAnnouncements();

  return (
    <div data-app-theme="" data-om-theme="light" style={shellRootStyle}>
      {topBar}
      <AnnouncementBanner announcements={announcements} />
      <div style={shellBodyStyle}>{children}</div>
    </div>
  );
}

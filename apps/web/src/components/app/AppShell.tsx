import type { ReactNode } from 'react';
import { shellBodyStyle, shellRootStyle } from './styles';

// App shell is light-only (matches the design — the Midnight Navy dark
// theme is scoped in packages/ui/src/theme.css but intentionally not
// wired up as a user-facing toggle here). `data-om-theme="light"` selects
// the [data-app-theme][data-om-theme='light'] token scope.
//
// Layout mirrors the design exactly: a full-width TopBar strip (brand +
// org switcher + search/notifications/avatar) sits above a row containing
// the Sidebar and the page content — the TopBar is not scoped to just the
// content column.
export default function AppShell({ topBar, children }: { topBar: ReactNode; children: ReactNode }) {
  return (
    <div data-app-theme="" data-om-theme="light" style={shellRootStyle}>
      {topBar}
      <div style={shellBodyStyle}>{children}</div>
    </div>
  );
}

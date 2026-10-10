import type { ReactElement } from 'react';

/**
 * Console icon set (Console dark/red/square theme). Replaces the old
 * Unicode-glyph nav icons ('\u25D1' etc.) with the same bespoke inline-SVG
 * convention already used elsewhere in the app (see
 * apps/web/src/components/canvas/navIcons.tsx): monochrome, `currentColor`,
 * viewBox 24x24, 1.6 stroke, round caps/joins. No new icon-library
 * dependency (console-plan's "e.g. lucide" is illustrative only — this
 * codebase doesn't use lucide anywhere).
 */

export type IconComponent = (props: { size?: number }) => ReactElement;

export const OverviewIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="4" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
    <rect x="13" y="4" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
    <rect x="4" y="13" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
    <rect x="13" y="13" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const TokenAnalyticsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M5 19V11M12 19V5M19 19v-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const SystemHealthIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 12h3.5l2-6 3 12 2-9 1.5 3H20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const UsersIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="9.5" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3.5 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M15.5 6a3 3 0 0 1 0 5.9M18 19.5c0-2.6-1.7-4.6-4-5.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const OrganizationsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="9" width="6" height="11" stroke="currentColor" strokeWidth="1.6" />
    <rect x="14" y="4" width="6" height="16" stroke="currentColor" strokeWidth="1.6" />
    <path d="M6.5 12h1M6.5 15h1M16.5 7h1M16.5 10h1M16.5 13h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const PlatformStaffIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.3 7 9 4.1-1.7 7-4.8 7-9V6l-7-2.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9.5 12 11.5 14 15 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ProjectsWorkflowsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="6" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="18" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const PlansIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4.5" y="4.5" width="15" height="15" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 9.5h8M8 13h8M8 16.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const AuditLogsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M6 4.5h9l3 3V19.5H6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9 11h6M9 14.5h6M9 18h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const AnnouncementsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 10.5v3h3l5 4V6.5l-5 4H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M16 9.5a4 4 0 0 1 0 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const ModelPricesIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M9.8 14.5c0 1 .9 1.7 2.2 1.7s2.2-.6 2.2-1.6c0-2.3-4.4-1.1-4.4-3.4 0-1 .9-1.6 2.2-1.6s2.2.6 2.2 1.6M12 7.8v1M12 15.2v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const AccessRequestsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3.5 19.5c0-3.3 2.7-5.5 5.5-5.5s5.5 2.2 5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M16 8.5h4.5M18.25 6.25v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const InvitationsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="6" width="16" height="12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M4.5 7 12 13l7.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SearchIcon: IconComponent = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.6" />
    <path d="m19 19-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const AlertIcon: IconComponent = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 4 21 20H3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="12" cy="17.2" r="0.9" fill="currentColor" />
  </svg>
);

export const ChevronRightIcon: IconComponent = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

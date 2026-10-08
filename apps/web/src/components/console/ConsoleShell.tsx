import type { ReactNode } from 'react';
import Link from 'next/link';
import { logout } from '@/lib/auth/actions';
import {
  consoleBodyRowStyle,
  consoleBrandMarkStyle,
  consoleBrandTextStyle,
  consoleEnvLabelStyle,
  consoleGhostBtnStyle,
  consoleIdentityAvatarStyle,
  consoleIdentityColStyle,
  consoleIdentityNameStyle,
  consoleIdentitySubStyle,
  consoleIdentityWrapStyle,
  consoleMainColStyle,
  consoleNavGroupLabelStyle,
  consoleNavIconStyle,
  consoleNavItemStyle,
  consoleShellRootStyle,
  consoleSidebarFooterLabelStyle,
  consoleSidebarFooterStyle,
  consoleSidebarFooterValueStyle,
  consoleSidebarStyle,
  consoleStaffBadgeStyle,
  consoleStaffBarStyle,
  consoleTopBarSpacerStyle,
  consoleTopBarStyle,
} from './styles';
import { buildNavGroups, type NavIconKey } from './navGroups';
import {
  AuditLogsIcon,
  AnnouncementsIcon,
  ModelPricesIcon,
  OrganizationsIcon,
  OverviewIcon,
  PlansIcon,
  PlatformStaffIcon,
  ProjectsWorkflowsIcon,
  SystemHealthIcon,
  TokenAnalyticsIcon,
  UsersIcon,
  type IconComponent,
} from './icons';

const NAV_ICON: Record<NavIconKey, IconComponent> = {
  overview: OverviewIcon,
  'token-analytics': TokenAnalyticsIcon,
  'system-health': SystemHealthIcon,
  users: UsersIcon,
  organizations: OrganizationsIcon,
  'platform-staff': PlatformStaffIcon,
  'projects-workflows': ProjectsWorkflowsIcon,
  plans: PlansIcon,
  'audit-logs': AuditLogsIcon,
  announcements: AnnouncementsIcon,
  'model-prices': ModelPricesIcon,
};

export default function ConsoleShell({
  activeNavId,
  email,
  paymentsEnabled = false,
  children,
}: {
  activeNavId: string;
  email: string;
  paymentsEnabled?: boolean;
  children: ReactNode;
}) {
  const groups = buildNavGroups(paymentsEnabled);
  const initials = email.slice(0, 2).toUpperCase();
  const env = process.env.NODE_ENV === 'production' ? 'PROD' : 'LOCAL';

  return (
    <div data-theme="console" className="console-theme" style={consoleShellRootStyle}>
      <div style={consoleStaffBarStyle} />
      <header style={consoleTopBarStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="Nia" style={consoleBrandMarkStyle} />
        <span style={consoleBrandTextStyle}>Nia Console</span>
        <span style={consoleStaffBadgeStyle}>ADMIN</span>
        <span style={consoleTopBarSpacerStyle} />
        <span style={consoleEnvLabelStyle(env)}>{env}</span>
        <div style={consoleIdentityWrapStyle}>
          <span style={consoleIdentityAvatarStyle}>{initials}</span>
          <div style={consoleIdentityColStyle}>
            <span style={consoleIdentityNameStyle}>{email}</span>
            <span style={consoleIdentitySubStyle}>Nia admin</span>
          </div>
        </div>
        <form action={logout}>
          <button type="submit" style={consoleGhostBtnStyle}>
            Sign out
          </button>
        </form>
      </header>

      <div style={consoleBodyRowStyle}>
        <nav style={consoleSidebarStyle}>
          {groups
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <div key={group.label}>
                <div style={consoleNavGroupLabelStyle}>{group.label}</div>
                {group.items.map((n) => {
                  const active = n.id === activeNavId;
                  const enabled = Boolean(n.href);
                  const Icon = NAV_ICON[n.icon];
                  const content = (
                    <>
                      <span style={consoleNavIconStyle(active)}>
                        <Icon size={16} />
                      </span>
                      <span style={{ flex: 1, textAlign: 'left', fontSize: 13 }}>{n.label}</span>
                    </>
                  );
                  return enabled ? (
                    <Link key={n.id} href={n.href!} style={consoleNavItemStyle(active, true)}>
                      {content}
                    </Link>
                  ) : (
                    <span key={n.id} style={consoleNavItemStyle(active, false)}>
                      {content}
                    </span>
                  );
                })}
              </div>
            ))}
          <span style={{ flex: 1 }} />
          <div style={consoleSidebarFooterStyle}>
            <span style={consoleSidebarFooterLabelStyle}>Console build</span>
            <span style={consoleSidebarFooterValueStyle}>Slice 3</span>
          </div>
        </nav>

        <div style={consoleMainColStyle}>{children}</div>
      </div>
    </div>
  );
}

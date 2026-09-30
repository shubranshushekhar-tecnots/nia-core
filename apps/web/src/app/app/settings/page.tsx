import { requireUser } from '@/lib/auth/session';
import { can } from '@nia/schemas';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle } from '@/components/app/styles';
import SettingsClient from '@/components/settings/SettingsClient';

export const dynamic = 'force-dynamic';

// Phase 1: Profile (name editable, email read-only), Appearance (3-card,
// the only theme control — the Sidebar's dropdown switcher was removed),
// Organization (name/slug editable for admin/owner only), Members & roles
// / Billing link rows, and
// Danger zone → Leave organization (reuses members/actions.ts's
// removeMember self-leave path). Password, Sessions, Notifications, API
// keys, Delete organization, Delete account are hidden — no backend exists
// for any of them yet (see docs/plans, Settings audit).
export default async function SettingsPage() {
  const user = await requireUser();
  const projects = await getSidebarProjects();

  // Matches the Sidebar's own gating exactly (components/app/Sidebar.tsx):
  // canBilling excludes plain members only, canViewMembers excludes viewer
  // and individual (members.view capability).
  const canBilling = user.org !== null && user.role !== 'member';
  const canViewMembers = can(user.role, 'members.view');
  const canUpdateOrg = Boolean(user.org) && can(user.role, 'org.update');

  return (
    <AppShell
      topBar={
        <TopBar
          orgName={user.org?.name ?? null}
          email={user.email}
          userId={user.userId}
          fullName={user.fullName}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
        />
      }
    >
      <Sidebar orgId={user.org?.id ?? null} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <SettingsClient
            userId={user.userId}
            email={user.email}
            fullName={user.fullName}
            org={user.org ? { id: user.org.id, name: user.org.name, slug: user.org.slug } : null}
            role={user.role}
            canUpdateOrg={canUpdateOrg}
            canViewMembers={canViewMembers}
            canBilling={canBilling}
          />
        </div>
      </div>
    </AppShell>
  );
}

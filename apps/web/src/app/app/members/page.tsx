import { requireUser } from '@/lib/auth/session';
import { can } from '@nia/schemas';
import { listMembers } from '@/lib/members/actions';
import { listInvites } from '@/lib/invites/actions';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle, pageTitleStyle } from '@/components/app/styles';
import MembersClient from '@/components/members/MembersClient';

export const dynamic = 'force-dynamic';

// Subscription Phase 2, Slice 7 — replaces the Sidebar's disabled
// "Members & roles — soon" item and folds the minimal /app/invites page
// (Slice 4) into one page, per spec. `members.view` includes plain
// members (read-only for them) but excludes viewer (DECISION-E,
// packages/schemas/src/can.ts) and individual (no org, no members to
// list) — RLS remains the real enforcement, this only avoids rendering
// the page to someone who'd see an empty/403 result anyway.
export default async function MembersPage() {
  const user = await requireUser();
  const projects = await getSidebarProjects();

  const allowed = Boolean(user.org) && can(user.role, 'members.view');
  const canInvite = allowed && can(user.role, 'members.invite');

  const [members, invites] = allowed
    ? await Promise.all([listMembers(), canInvite ? listInvites() : Promise.resolve([])])
    : [[], []];

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={pageTitleStyle}>Members & roles</span>
            {user.org && (
              <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
                Everyone with access to {user.org.name}, and their role.
              </span>
            )}
          </div>

          {allowed && user.org ? (
            <MembersClient
              // `allowed` already excludes "individual"/"viewer" (can() requires member/admin/owner).
              callerRole={user.role as Exclude<typeof user.role, 'individual' | 'viewer'>}
              callerUserId={user.userId}
              members={members}
              canInvite={canInvite}
              invites={invites}
            />
          ) : (
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              You don&apos;t have permission to view this page.
            </span>
          )}
        </div>
      </div>
    </AppShell>
  );
}

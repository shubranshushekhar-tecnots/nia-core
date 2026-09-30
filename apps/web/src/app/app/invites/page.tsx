import { requireUser } from '@/lib/auth/session';
import { can } from '@nia/schemas';
import { listInvites } from '@/lib/invites/actions';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle, pageTitleStyle } from '@/components/app/styles';
import InvitesClient from '@/components/app/InvitesClient';

export const dynamic = 'force-dynamic';

// Minimal admin-only invites page (Subscription Phase 2, Slice 4). The full
// Members & roles page is slice 7 — this covers only create/list/revoke +
// the accept flow (/invite/[token]/page.tsx). Real authorization is the
// RLS policies + RPCs behind listInvites()/createInvite()/revokeInvite()
// (supabase/migrations/0058_invite_links.sql); the can() check below just
// avoids rendering the form/list to someone who'd get a 403/empty result
// anyway.
export default async function InvitesPage() {
  const user = await requireUser();
  const projects = await getSidebarProjects();

  const allowed = Boolean(user.org) && can(user.role, 'members.invite');
  const invites = allowed ? await listInvites() : [];

  return (
    <AppShell
      topBar={
        <TopBar
          orgName={user.org?.name ?? null}
          email={user.email}
          userId={user.userId}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
        />
      }
    >
      <Sidebar orgId={user.org?.id ?? null} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={pageTitleStyle}>Invites</span>
            {user.org && (
              <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
                Invite people to {user.org.name}. No project access is granted by the invite itself — admins add
                members to projects separately.
              </span>
            )}
          </div>

          {allowed && user.org ? (
            // `allowed` already excludes "individual" (can() requires admin/owner).
            <InvitesClient invites={invites} callerRole={user.role as Exclude<typeof user.role, 'individual'>} />
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

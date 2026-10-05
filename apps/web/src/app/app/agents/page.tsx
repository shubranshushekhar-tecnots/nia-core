import { requireUser } from '@/lib/auth/session';
import { can } from '@nia/schemas';
import { getAgents } from '@/lib/api/agentsServer';
import { listMembers } from '@/lib/members/actions';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle } from '@/components/app/styles';
import AgentsClient from '@/components/agents/AgentsClient';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const user = await requireUser();
  const projects = await getSidebarProjects();

  const canView = can(user.role, 'agents.view');
  const canPair = can(user.role, 'agents.pair');

  const [agents, members] = canView
    ? await Promise.all([getAgents(), user.org ? listMembers() : Promise.resolve([])])
    : [[], []];

  // userId -> display name, for the "who paired it" column. Falls back to
  // the raw createdByUserId in AgentsClient when a member has since left
  // the org (listMembers only returns current members).
  const memberNames: Record<string, string> = {};
  for (const m of members) {
    memberNames[m.userId] = m.name || m.email || m.userId;
  }

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
      <Sidebar orgId={user.org?.id ?? null} role={user.role} projects={projects} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <AgentsClient
            callerRole={user.role}
            callerUserId={user.userId}
            agents={agents}
            memberNames={memberNames}
            canPair={canPair}
          />
        </div>
      </div>
    </AppShell>
  );
}

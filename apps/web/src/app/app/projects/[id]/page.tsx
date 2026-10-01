import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getProjectDetail, getSidebarProjects } from '@/lib/api/dashboardServer';
import { listProjectMembers } from '@/lib/projectMembers/actions';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ProjectDetailClient from '@/components/app/ProjectDetailClient';
import { mainColStyle, nxConnScrollStyle } from '@/components/app/styles';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  // Project members panel only applies to org-scoped projects (personal/
  // owner_id projects have no membership concept beyond their one owner —
  // see lib/projectMembers/actions.ts's header comment).
  const [project, projects, projectMembers] = await Promise.all([
    getProjectDetail(id),
    getSidebarProjects(),
    orgId ? listProjectMembers(id) : Promise.resolve(null),
  ]);

  if (!project) redirect('/app');

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
          crumbs={[{ label: 'Projects', href: '/app/projects' }, { label: project.name }]}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} />
      <div style={mainColStyle}>
        <div style={nxConnScrollStyle}>
          <ProjectDetailClient
            orgId={orgId}
            orgName={user.org?.name ?? null}
            project={project}
            projects={projects}
            callerRole={user.role}
            callerUserId={user.userId}
            projectMembers={projectMembers}
          />
        </div>
      </div>
    </AppShell>
  );
}

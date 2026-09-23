import { requireUser } from '@/lib/auth/session';
import { getProjectsList, getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ProjectsListClient from '@/components/app/ProjectsListClient';
import { mainColStyle, projectScrollStyle } from '@/components/app/styles';

export default async function ProjectsListPage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  const [projectsList, sidebarProjects] = await Promise.all([getProjectsList(), getSidebarProjects()]);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={sidebarProjects} email={user.email} />
      <div style={mainColStyle}>
        <div style={projectScrollStyle}>
          <ProjectsListClient orgId={orgId} projects={projectsList} />
        </div>
      </div>
    </AppShell>
  );
}

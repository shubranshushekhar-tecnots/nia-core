import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getProjectDetail, getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ProjectDetailClient from '@/components/app/ProjectDetailClient';
import { mainColStyle, projectScrollStyle } from '@/components/app/styles';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  const [project, projects] = await Promise.all([getProjectDetail(id), getSidebarProjects()]);

  if (!project) redirect('/app');

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={projectScrollStyle}>
          <ProjectDetailClient orgId={orgId} orgName={user.org?.name ?? null} project={project} projects={projects} />
        </div>
      </div>
    </AppShell>
  );
}

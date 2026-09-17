import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects, getWorkflowDetail } from '@/lib/api/dashboardServer';
import { getConnections } from '@/lib/api/connectionsServer';
import { getWorkflowGraph } from '@/lib/api/workflowGraphServer';
import { getWorkflowConversation } from '@/lib/api/chatServer';
import CanvasQueryProvider from '@/components/canvas/CanvasQueryProvider';
import FlowCanvas from '@/components/canvas/FlowCanvas';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { mainColStyle } from '@/components/app/styles';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  const workflow = await getWorkflowDetail(id);
  if (!workflow) redirect('/app');

  const [connections, initialGraph, projects, workflowConversation] = await Promise.all([
    getConnections(),
    getWorkflowGraph(id),
    getSidebarProjects(),
    getWorkflowConversation(id),
  ]);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <CanvasQueryProvider>
          <FlowCanvas
            workflow={workflow}
            connections={connections}
            initialGraph={initialGraph}
            initialConversation={workflowConversation?.conversation ?? null}
            initialMessages={workflowConversation?.messages ?? []}
          />
        </CanvasQueryProvider>
      </div>
    </AppShell>
  );
}

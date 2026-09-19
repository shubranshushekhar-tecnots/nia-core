import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects, getWorkflowDetail } from '@/lib/api/dashboardServer';
import { getConnections } from '@/lib/api/connectionsServer';
import { getWorkflowGraph } from '@/lib/api/workflowGraphServer';
import { getWorkflowConversation } from '@/lib/api/chatServer';
import CanvasQueryProvider from '@/components/canvas/CanvasQueryProvider';
import FlowCanvas from '@/components/canvas/FlowCanvas';
import CanvasIconRail from '@/components/canvas/CanvasIconRail';
import { canvasPageRootStyle } from '@/components/canvas/styles';

// Canvas redesign (designs/canvasredesign.html): this route renders its own
// chrome — CanvasIconRail (56px icon rail) + FlowCanvas's own CanvasHeader
// (48px merged header) — instead of the shared AppShell/Sidebar/TopBar used
// by every other /app/* route. Those three stay untouched for other routes.
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
    <div style={canvasPageRootStyle} data-app-theme="" data-om-theme="light">
      <CanvasIconRail orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <CanvasQueryProvider>
        <FlowCanvas
          orgName={user.org?.name ?? null}
          workflow={workflow}
          connections={connections}
          initialGraph={initialGraph}
          initialConversation={workflowConversation?.conversation ?? null}
          initialMessages={workflowConversation?.messages ?? []}
        />
      </CanvasQueryProvider>
    </div>
  );
}

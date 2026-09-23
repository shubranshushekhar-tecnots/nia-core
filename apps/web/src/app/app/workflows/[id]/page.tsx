import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects, getWorkflowDetail } from '@/lib/api/dashboardServer';
import { getConnections, getConnectorInstalls } from '@/lib/api/connectionsServer';
import { getWorkflowGraph } from '@/lib/api/workflowGraphServer';
import { getWorkflowConversation } from '@/lib/api/chatServer';
import CanvasQueryProvider from '@/components/canvas/CanvasQueryProvider';
import FlowCanvas from '@/components/canvas/FlowCanvas';

// Canvas redesign (designs/canvasredesign.html): this route renders its own
// chrome — FlowCanvas's own CanvasHeader (merged header) instead of
// AppShell/TopBar — but mirrors AppShell's column-then-row structure
// (full-width header on top, then Sidebar + content row below it) so the
// rail sits in the exact same place as every other /app/* route. FlowCanvas
// owns that page-root div itself (not this file) since the header/sidebar
// depend on state that lives inside FlowCanvas.
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  const workflow = await getWorkflowDetail(id);
  if (!workflow) redirect('/app');

  const [connections, connectorInstalls, initialGraph, projects, workflowConversation] = await Promise.all([
    getConnections(),
    getConnectorInstalls(),
    getWorkflowGraph(id),
    getSidebarProjects(),
    getWorkflowConversation(id),
  ]);

  return (
    <CanvasQueryProvider>
      <FlowCanvas
        orgId={orgId}
        orgName={user.org?.name ?? null}
        role={user.role}
        sidebarProjects={projects}
        email={user.email}
        workflow={workflow}
        connections={connections}
        connectorInstalls={connectorInstalls}
        initialGraph={initialGraph}
        initialConversation={workflowConversation?.conversation ?? null}
        initialMessages={workflowConversation?.messages ?? []}
      />
    </CanvasQueryProvider>
  );
}

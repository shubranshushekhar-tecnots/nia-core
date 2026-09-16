import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getWorkflowDetail } from '@/lib/api/dashboardServer';
import { getConnections } from '@/lib/api/connectionsServer';
import { getWorkflowGraph } from '@/lib/api/workflowGraphServer';
import CanvasQueryProvider from '@/components/canvas/CanvasQueryProvider';
import FlowCanvas from '@/components/canvas/FlowCanvas';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser();

  const workflow = await getWorkflowDetail(id);
  if (!workflow) redirect('/app');

  const [connections, initialGraph] = await Promise.all([getConnections(), getWorkflowGraph(id)]);

  return (
    <CanvasQueryProvider>
      <FlowCanvas workflow={workflow} connections={connections} initialGraph={initialGraph} />
    </CanvasQueryProvider>
  );
}

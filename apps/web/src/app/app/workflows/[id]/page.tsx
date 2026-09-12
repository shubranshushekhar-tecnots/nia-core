import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getWorkflowDetail } from '@/lib/api/dashboardServer';
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser();

  const workflow = await getWorkflowDetail(id);
  if (!workflow) redirect('/app');

  return <WorkflowCanvas workflow={workflow} />;
}

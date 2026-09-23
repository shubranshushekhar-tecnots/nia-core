import { apiFetchServer, ApiError } from './server';
import type {
  ContinueWorkflow,
  DashboardStats,
  ProjectDetail,
  ProjectListItem,
  RecentRun,
  SidebarProject,
  WorkflowDetail,
} from '@/lib/dashboard/types';

export function getSidebarProjects(): Promise<SidebarProject[]> {
  return apiFetchServer<SidebarProject[]>('/projects/sidebar');
}

export function getProjectsList(): Promise<ProjectListItem[]> {
  return apiFetchServer<ProjectListItem[]>('/projects');
}

/** Matches queries.ts's original `ProjectDetail | null` contract — a 404 from Express resolves to null instead of throwing, so pages keep their `if (!project) redirect('/app')` shape. */
export async function getProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  try {
    return await apiFetchServer<ProjectDetail>(`/projects/${projectId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Same 404-to-null contract as getProjectDetail, matching queries.ts. */
export async function getWorkflowDetail(workflowId: string): Promise<WorkflowDetail | null> {
  try {
    return await apiFetchServer<WorkflowDetail>(`/workflows/${workflowId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function getDashboardStats(): Promise<DashboardStats> {
  return apiFetchServer<DashboardStats>('/dashboard/stats');
}

export function getContinueWorkflow(): Promise<ContinueWorkflow | null> {
  return apiFetchServer<ContinueWorkflow | null>('/dashboard/continue');
}

export function getRecentRuns(limit?: number): Promise<RecentRun[]> {
  return apiFetchServer<RecentRun[]>(`/dashboard/recent-runs${limit ? `?limit=${limit}` : ''}`);
}

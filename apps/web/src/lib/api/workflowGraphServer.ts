import { apiFetchServer } from './server';
import type { GraphDoc } from '@nia/schemas';

export type WorkflowGraphResult = { graph: GraphDoc; version: number };

// Initial load only (Server Component, page.tsx) — same GET the browser-side
// graphClient.ts calls, but through the Bearer/cookie-derived server client
// (apiFetchServer) instead of a manual browser Authorization header. Autosave
// PUTs and any post-409 reload happen client-side via graphClient.ts, never
// here, so the two paths don't race on which one "owns" auth for this route.
export function getWorkflowGraph(workflowId: string): Promise<WorkflowGraphResult> {
  return apiFetchServer<WorkflowGraphResult>(`/workflows/${workflowId}/graph`);
}

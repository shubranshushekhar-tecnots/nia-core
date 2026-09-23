import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WorkflowStatus } from "./projects.js";

/** 1:1 port of apps/web/src/lib/dashboard/queries.ts's getWorkflowDetail. */
export type CanvasNode = {
  id: string;
  kind: "source" | "transform" | "dest" | "file" | "trigger";
  tool: string;
  handle: string;
  x: number;
  y: number;
  config: Record<string, string>;
};

export type CanvasWire = [string, string];

export type WorkflowDefinition = { nodes: CanvasNode[]; wires: CanvasWire[] };

export type WorkflowDetail = {
  id: string;
  name: string;
  status: WorkflowStatus;
  updatedAt: string;
  project: { id: string; name: string };
  definition: WorkflowDefinition;
};

export async function getWorkflowDetail(
  supabase: SupabaseClient,
  workflowId: string,
  scope: WorkspaceScope,
): Promise<WorkflowDetail | null> {
  let query = supabase
    .from("workflows")
    .select("id, name, status, updated_at, definition, projects ( id, name )")
    .eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle();

  if (!data) return null;
  const project = data.projects as unknown as { id: string; name: string } | null;
  if (!project) return null;

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    updatedAt: data.updated_at,
    project,
    definition: (data.definition ?? { nodes: [], wires: [] }) as WorkflowDefinition,
  };
}

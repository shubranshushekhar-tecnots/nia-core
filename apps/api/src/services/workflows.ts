import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import type { WithUser } from "../lib/withUser.js";
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

type WorkflowDetailRow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  updated_at: string;
  definition: unknown;
  project_id: string;
  project_name: string;
};

export async function getWorkflowDetail(
  withUser: WithUser,
  workflowId: string,
  scope: WorkspaceScope,
): Promise<WorkflowDetail | null> {
  // workspaceWhere's org_id/owner_id are bare column names, ambiguous
  // against a join where both workflows and projects have those columns —
  // scope via a subquery against the unaliased, unjoined workflows table
  // instead of qualifying columns by hand.
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<WorkflowDetailRow>(
      `select w.id, w.name, w.status, w.updated_at, w.definition, p.id as project_id, p.name as project_name
       from workflows w
       join projects p on p.id = w.project_id
       where w.id = $1 and w.id in (select id from workflows where ${where.sql})`,
      [workflowId, ...where.params],
    ),
  );

  const data = rows[0];
  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    updatedAt: data.updated_at,
    project: { id: data.project_id, name: data.project_name },
    definition: (data.definition ?? { nodes: [], wires: [] }) as WorkflowDefinition,
  };
}

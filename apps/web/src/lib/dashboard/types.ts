/**
 * Shared dashboard/project/workflow data shapes. Split out from the old
 * lib/dashboard/queries.ts (which fetched these directly from Supabase)
 * once that data moved to Express — lib/api/dashboardServer.ts now
 * produces these same shapes, but presentational components shouldn't
 * care which one built them, so the types live here independently of
 * either.
 */
export type WorkflowStatus = "draft" | "active" | "paused";
export type RunStatus = "running" | "succeeded" | "failed";

export type SidebarProject = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus }[];
};

export type ContinueWorkflow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  projectName: string;
  updatedAt: string;
};

export type RecentRun = {
  id: string;
  status: RunStatus;
  workflowId: string;
  workflowName: string;
  rowsProcessed: number;
  durationMs: number | null;
  startedAt: string;
};

export type DashboardStats = {
  projectCount: number;
  workflowCount: number;
  activeWorkflowCount: number;
};

export type ProjectDetail = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus; updatedAt: string }[];
};

export type ProjectListItem = {
  id: string;
  name: string;
  workflowCount: number;
  lastRunAt: string | null;
};

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

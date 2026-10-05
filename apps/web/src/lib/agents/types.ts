// docs/plans/agent-canvas-integration.md Slice L3 — mirrors apps/api/src/services/agents.ts's PlatformAgent.
export type PlatformAgent = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "revoked";
  agentVersion: string | null;
  hostName: string | null;
  lastCheckInAt: string | null;
  createdByUserId: string;
  createdAt: string;
  online: boolean;
};

// Slice L4 — mirrors apps/api/src/services/agents.ts's LocalJobSummary
// exactly (the allow-list). Read-only: jobs set up on the agent machine
// via the CLI, never published from the platform.
export type LocalJobSummary = {
  id: string;
  name: string;
  connectionName: string;
  sourceTable: string;
  destinationType: string;
  destinationHost: string;
  mode: string;
  schedule?: string;
  state: "ok" | "failing" | "paused";
  errorClass?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  consecutiveFailures: number;
};

export type AgentSetup = {
  id: string;
  source: "platform" | "local";
  localJob: LocalJobSummary | null;
};

export type AgentSetupRun = {
  id: string;
  agentSetupId: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  parts: number;
  mode: string | null;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
  isRealtimeAggregate: boolean;
  periodStart: string | null;
  periodEnd: string | null;
};

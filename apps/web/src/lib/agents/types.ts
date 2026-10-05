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

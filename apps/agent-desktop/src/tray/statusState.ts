export type ConnectionColor = "green" | "amber" | "grey";

export interface ConnectionState {
  color: ConnectionColor;
  label: string;
}

/** Mirrors apps/agent/src/localApi/routes/status.ts's GET /status response shape (Phase 6 polish). */
export interface AgentPendingUpdate {
  version: string;
  readyToInstall: boolean;
}

/** Mirrors apps/agent/src/localApi/routes/status.ts's GET /status response shape. */
export interface AgentStatus {
  paired: boolean;
  platformUrl?: string;
  online?: boolean;
  revoked?: boolean;
  pendingUpdate?: AgentPendingUpdate;
}

function pendingUpdateSuffix(pendingUpdate: AgentPendingUpdate | undefined): string {
  if (!pendingUpdate) return "";
  return pendingUpdate.readyToInstall ? ` -- update ${pendingUpdate.version} ready to install` : ` -- update ${pendingUpdate.version} available`;
}

/** `null` means the status fetch itself failed (service not running / unreachable). */
export function mapStatusToConnectionState(status: AgentStatus | null): ConnectionState {
  if (status === null) {
    return { color: "grey", label: "Not connected -- service isn't running" };
  }
  if (!status.paired) {
    return { color: "grey", label: "Not paired yet" };
  }
  if (status.online && !status.revoked) {
    const base = status.platformUrl ? `Connected to ${status.platformUrl}` : "Connected";
    return { color: "green", label: base + pendingUpdateSuffix(status.pendingUpdate) };
  }
  if (status.revoked) {
    return { color: "amber", label: "Access revoked -- re-pair this agent" };
  }
  return { color: "amber", label: "Connection problem" };
}

export type TrayStateKind = "idle" | "syncing" | "starting" | "problem" | "off";

export interface TrayState {
  kind: TrayStateKind;
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
  isSyncing?: boolean;
  pendingUpdate?: AgentPendingUpdate;
}

function pendingUpdateSuffix(pendingUpdate: AgentPendingUpdate | undefined): string {
  if (!pendingUpdate) return "";
  return pendingUpdate.readyToInstall ? ` -- update ${pendingUpdate.version} ready to install` : ` -- update ${pendingUpdate.version} available`;
}

/**
 * `null` means the status fetch itself failed (service not running / unreachable) -> "off".
 * Otherwise: unpaired -> "starting" (pre-pair build-up); revoked/offline -> "problem";
 * a job actually in flight right now -> "syncing"; else -> "idle".
 */
export function mapStatusToConnectionState(status: AgentStatus | null): TrayState {
  if (status === null) {
    return { kind: "off", label: "Not connected -- service isn't running" };
  }
  if (!status.paired) {
    return { kind: "starting", label: "Not paired yet" };
  }
  if (status.revoked) {
    return { kind: "problem", label: "Access revoked -- re-pair this agent" };
  }
  if (!status.online) {
    return { kind: "problem", label: "Connection problem" };
  }
  const base = status.platformUrl ? `Connected to ${status.platformUrl}` : "Connected";
  const label = base + pendingUpdateSuffix(status.pendingUpdate);
  if (status.isSyncing) {
    return { kind: "syncing", label };
  }
  return { kind: "idle", label };
}

import type { AgentSetup, AgentSetupRun, LocalJobSummary } from "./types";

/**
 * Explicit whitelist mapping, same rationale as mapAgent.ts: a raw
 * /agents/:id/setups response can only ever surface the fields picked
 * out here. Slice L4 (B.11/B.7) — these are the allow-listed fields the
 * agent reports and the bridge stores; nothing else (row values, param
 * values, Planometry rejection messages) can reach rendered UI state even
 * if a future bug leaked more through the API.
 */
function mapLocalJob(raw: unknown): LocalJobSummary | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    connectionName: String(row.connectionName ?? ""),
    sourceTable: String(row.sourceTable ?? ""),
    destinationType: String(row.destinationType ?? ""),
    destinationHost: String(row.destinationHost ?? ""),
    mode: String(row.mode ?? ""),
    schedule: typeof row.schedule === "string" ? row.schedule : undefined,
    state: (row.state as LocalJobSummary["state"]) ?? "ok",
    errorClass: typeof row.errorClass === "string" ? row.errorClass : undefined,
    lastRunAt: typeof row.lastRunAt === "string" ? row.lastRunAt : undefined,
    nextRunAt: typeof row.nextRunAt === "string" ? row.nextRunAt : undefined,
    consecutiveFailures: typeof row.consecutiveFailures === "number" ? row.consecutiveFailures : 0,
  };
}

function mapAgentSetup(raw: unknown): AgentSetup {
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    source: (row.source as AgentSetup["source"]) ?? "local",
    localJob: mapLocalJob(row.localJob),
  };
}

function mapAgentSetupRun(raw: unknown): AgentSetupRun {
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    agentSetupId: String(row.agentSetupId ?? ""),
    status: (row.status as AgentSetupRun["status"]) ?? "failed",
    rowsSent: typeof row.rowsSent === "number" ? row.rowsSent : 0,
    rowsDeleted: typeof row.rowsDeleted === "number" ? row.rowsDeleted : 0,
    parts: typeof row.parts === "number" ? row.parts : 0,
    mode: typeof row.mode === "string" ? row.mode : null,
    errorClass: typeof row.errorClass === "string" ? row.errorClass : null,
    startedAt: String(row.startedAt ?? ""),
    finishedAt: String(row.finishedAt ?? ""),
    isRealtimeAggregate: Boolean(row.isRealtimeAggregate),
    periodStart: typeof row.periodStart === "string" ? row.periodStart : null,
    periodEnd: typeof row.periodEnd === "string" ? row.periodEnd : null,
  };
}

export function mapAgentSetupsResponse(raw: unknown): { setups: AgentSetup[]; runs: AgentSetupRun[] } {
  const body = raw as Record<string, unknown>;
  const setups = Array.isArray(body.setups) ? body.setups.map(mapAgentSetup) : [];
  const runs = Array.isArray(body.runs) ? body.runs.map(mapAgentSetupRun) : [];
  return { setups, runs };
}

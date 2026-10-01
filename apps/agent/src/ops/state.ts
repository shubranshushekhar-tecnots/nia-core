import fs from "node:fs";
import { defaultHomeDir, stateFilePath } from "../config/paths.js";

/**
 * Small local state file (Phase 2 §7, extended by Phase 3b §3: "`agent
 * status` shows per-connection state — last poll, last sync, last
 * error, spool usage"). Never holds row data or secrets — only
 * timestamps, counts, and error messages. Spool usage itself isn't
 * stored here (it's read live off disk at status time — see
 * ops/spoolUsage.ts) since it can change between polls without any
 * state-file write.
 */
export interface ConnectionState {
  lastSyncAt?: string;
  lastSyncRows?: number;
  lastErrorAt?: string;
  lastError?: string;
  catalogFingerprint?: string;
  /** Set on every `GET /v1/work` poll, whether or not it returned work. */
  lastPollAt?: string;
  /** Consecutive sync failures for this connection, reset to 0 on the next success. Drives the repeated-failure log escalation (ops/syncFailureLog.ts) without needing to scan the log file itself. */
  consecutiveFailures?: number;
}

export interface AgentState {
  /** Set once per process start; status's "uptime" is derived from this. */
  startedAt?: string;
  connections: Record<string, ConnectionState>;
}

function emptyState(): AgentState {
  return { connections: {} };
}

export function readState(dir = defaultHomeDir()): AgentState {
  const file = stateFilePath(dir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentState>;
    return { startedAt: parsed.startedAt, connections: parsed.connections ?? {} };
  } catch {
    return emptyState();
  }
}

export function writeState(state: AgentState, dir = defaultHomeDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFilePath(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function recordAgentStarted(dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.startedAt = new Date().toISOString();
  writeState(state, dir);
}

export function recordSyncComplete(connectionId: string, rows: number, dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.connections[connectionId] = {
    ...state.connections[connectionId],
    lastSyncAt: new Date().toISOString(),
    lastSyncRows: rows,
    lastError: undefined,
    lastErrorAt: undefined,
    consecutiveFailures: 0,
  };
  writeState(state, dir);
}

/** Returns the connection's new consecutive-failure count, so the caller (ops/syncFailureLog.ts) can decide whether to escalate the log line without a second state read. */
export function recordSyncFailed(connectionId: string, error: string, dir = defaultHomeDir()): number {
  const state = readState(dir);
  const consecutiveFailures = (state.connections[connectionId]?.consecutiveFailures ?? 0) + 1;
  state.connections[connectionId] = {
    ...state.connections[connectionId],
    lastErrorAt: new Date().toISOString(),
    lastError: error,
    consecutiveFailures,
  };
  writeState(state, dir);
  return consecutiveFailures;
}

export function recordCatalogFingerprint(connectionId: string, fingerprint: string, dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.connections[connectionId] = { ...state.connections[connectionId], catalogFingerprint: fingerprint };
  writeState(state, dir);
}

export function recordPoll(connectionId: string, dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.connections[connectionId] = { ...state.connections[connectionId], lastPollAt: new Date().toISOString() };
  writeState(state, dir);
}

export interface StatusReport {
  startedAt?: string;
  uptimeSeconds?: number;
  connections: Record<string, ConnectionState>;
}

export function getStatus(dir = defaultHomeDir()): StatusReport {
  const state = readState(dir);
  const uptimeSeconds = state.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 1000)) : undefined;
  return { startedAt: state.startedAt, uptimeSeconds, connections: state.connections };
}

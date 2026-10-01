import fs from "node:fs";
import { defaultHomeDir, stateFilePath } from "../config/paths.js";

/**
 * Small local state file (Phase 2 §7: "`agent status` CLI reading a
 * small local state file — last sync/error per connection, catalog
 * fingerprint, uptime"). Never holds row data or secrets — only
 * timestamps, counts, and error messages.
 */
export interface ConnectionState {
  lastSyncAt?: string;
  lastSyncRows?: number;
  lastErrorAt?: string;
  lastError?: string;
  catalogFingerprint?: string;
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
  };
  writeState(state, dir);
}

export function recordSyncFailed(connectionId: string, error: string, dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.connections[connectionId] = {
    ...state.connections[connectionId],
    lastErrorAt: new Date().toISOString(),
    lastError: error,
  };
  writeState(state, dir);
}

export function recordCatalogFingerprint(connectionId: string, fingerprint: string, dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.connections[connectionId] = { ...state.connections[connectionId], catalogFingerprint: fingerprint };
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

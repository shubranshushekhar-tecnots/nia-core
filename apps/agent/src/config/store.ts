import fs from "node:fs";
import {
  type AgentConfig,
  type AutoUpdateConfig,
  type ConnectionEntry,
  type LinkConfig,
  type MonitoringConfig,
  type SyncJobEntry,
  CURRENT_CONFIG_VERSION,
  emptyConfig,
} from "./types.js";
import { configFilePath, defaultHomeDir } from "./paths.js";

export class ConfigValidationError extends Error {}

/** Returns an empty config if the file doesn't exist yet (first run) — `agent connection add` creates it. */
export function loadConfig(dir = defaultHomeDir()): AgentConfig {
  const file = configFilePath(dir);
  if (!fs.existsSync(file)) return emptyConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ConfigValidationError(`${file} is not valid JSON`);
  }
  return validateConfig(parsed);
}

export function saveConfig(config: AgentConfig, dir = defaultHomeDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFilePath(dir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Shallow validation only — just enough to catch a hand-edited or
 * corrupted file before it reaches the rest of the agent. A malformed
 * individual connection/job entry (e.g. missing `sqlserver.host`) surfaces
 * naturally when that entry is actually used, not here.
 */
export function validateConfig(value: unknown): AgentConfig {
  if (typeof value !== "object" || value === null) {
    throw new ConfigValidationError("agent.config.json must be a JSON object");
  }
  const v = value as Record<string, unknown>;
  if (v.version !== CURRENT_CONFIG_VERSION) {
    throw new ConfigValidationError(`agent.config.json has unsupported version ${JSON.stringify(v.version)}`);
  }
  if (!Array.isArray(v.connections)) {
    throw new ConfigValidationError("agent.config.json's connections must be an array");
  }
  if (v.jobs !== undefined && !Array.isArray(v.jobs)) {
    throw new ConfigValidationError("agent.config.json's jobs must be an array");
  }
  return {
    version: CURRENT_CONFIG_VERSION,
    spoolDir: typeof v.spoolDir === "string" ? v.spoolDir : undefined,
    monitoring: validateMonitoring(v.monitoring),
    maxConcurrentRuns: typeof v.maxConcurrentRuns === "number" ? v.maxConcurrentRuns : undefined,
    link: validateLink(v.link),
    autoUpdate: validateAutoUpdate(v.autoUpdate),
    connections: v.connections as ConnectionEntry[],
    jobs: (v.jobs as SyncJobEntry[] | undefined) ?? [],
  };
}

/** Unset unless `enabled` is well-typed — a partially hand-edited `autoUpdate` is treated the same as unset (i.e. disabled, per AutoUpdateConfig's doc comment). */
function validateAutoUpdate(value: unknown): AutoUpdateConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") return undefined;
  return { enabled: v.enabled };
}

/** `updateChecker.ts`'s own "is auto-update on" read — unset config (or a config whose `autoUpdate` was dropped by `validateAutoUpdate` above) means disabled. See docs/handoff/auto-update-0.0.8.md. */
export function isAutoUpdateEnabled(config: AgentConfig): boolean {
  return config.autoUpdate?.enabled ?? false;
}

export function setAutoUpdateEnabled(config: AgentConfig, enabled: boolean): AgentConfig {
  return { ...config, autoUpdate: { enabled } };
}

function validateMonitoring(value: unknown): MonitoringConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return {
    heartbeatUrl: typeof v.heartbeatUrl === "string" ? v.heartbeatUrl : undefined,
    intervalSeconds: typeof v.intervalSeconds === "number" ? v.intervalSeconds : undefined,
  };
}

/** Unset unless all three fields are present and well-typed — a partially hand-edited `link` is treated the same as unpaired. */
function validateLink(value: unknown): LinkConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.platformUrl !== "string" || typeof v.agentId !== "string" || typeof v.agentKeyRef !== "string") return undefined;
  return { platformUrl: v.platformUrl, agentId: v.agentId, agentKeyRef: v.agentKeyRef };
}

export function findConnection(config: AgentConfig, id: string): ConnectionEntry | undefined {
  return config.connections.find((c) => c.id === id);
}

export function upsertConnection(config: AgentConfig, entry: ConnectionEntry): AgentConfig {
  const idx = config.connections.findIndex((c) => c.id === entry.id);
  const connections = [...config.connections];
  if (idx === -1) connections.push(entry);
  else connections[idx] = entry;
  return { ...config, connections };
}

export function removeConnection(config: AgentConfig, id: string): AgentConfig {
  return { ...config, connections: config.connections.filter((c) => c.id !== id) };
}

export function findJob(config: AgentConfig, id: string): SyncJobEntry | undefined {
  return config.jobs.find((j) => j.id === id);
}

export function jobsForConnection(config: AgentConfig, connectionId: string): SyncJobEntry[] {
  return config.jobs.filter((j) => j.connectionId === connectionId);
}

export function upsertJob(config: AgentConfig, entry: SyncJobEntry): AgentConfig {
  const idx = config.jobs.findIndex((j) => j.id === entry.id);
  const jobs = [...config.jobs];
  if (idx === -1) jobs.push(entry);
  else jobs[idx] = entry;
  return { ...config, jobs };
}

export function removeJob(config: AgentConfig, id: string): AgentConfig {
  return { ...config, jobs: config.jobs.filter((j) => j.id !== id) };
}

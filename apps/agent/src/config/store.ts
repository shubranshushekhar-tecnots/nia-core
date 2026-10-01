import fs from "node:fs";
import { type AgentConfig, type ConnectionEntry, CURRENT_CONFIG_VERSION, emptyConfig } from "./types.js";
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
 * individual connection entry (e.g. missing `sqlserver.host`) surfaces
 * naturally when that connection is actually used, not here.
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
  return {
    version: CURRENT_CONFIG_VERSION,
    spoolDir: typeof v.spoolDir === "string" ? v.spoolDir : undefined,
    connections: v.connections as ConnectionEntry[],
  };
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

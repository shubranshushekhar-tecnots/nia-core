import path from "node:path";

/**
 * All agent state (config, secrets, keyfile, spool, logs, status) lives
 * under one app-data directory. `NIA_AGENT_HOME` overrides it — required
 * for tests (which must never touch the real `/etc/nia-agent` or
 * `%ProgramData%\NiaAgent`) and useful for a non-default install location.
 */
export function defaultHomeDir(): string {
  if (process.env.NIA_AGENT_HOME) return process.env.NIA_AGENT_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData ?? "C:\\ProgramData", "NiaAgent");
  }
  return "/etc/nia-agent";
}

export function configFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "agent.config.json");
}

export function secretsFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "secrets.enc.json");
}

export function keyFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "master.key");
}

export function defaultSpoolDir(dir = defaultHomeDir()): string {
  return path.join(dir, "spool");
}

export function stateFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "state.json");
}

export function defaultLogDir(dir = defaultHomeDir()): string {
  return path.join(dir, "logs");
}

export function defaultLocksDir(dir = defaultHomeDir()): string {
  return path.join(dir, "locks");
}

/** One JSON file per job under here (ops/state.ts) — written atomically by both the running service and manual `job run`s. */
export function jobStateDir(dir = defaultHomeDir()): string {
  return path.join(dir, "job-state");
}

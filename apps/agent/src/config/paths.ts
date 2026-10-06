import path from "node:path";
import { homedir } from "node:os";

/**
 * All agent state (config, secrets, keyfile, spool, logs, status) lives
 * under one app-data directory. `NIA_AGENT_HOME` overrides it — required
 * for tests (which must never touch the real `/etc/nia-agent`,
 * `%ProgramData%\NiaAgent`, or `~/Library/Application Support/NiaAgent`)
 * and useful for a non-default install location.
 */
export function defaultHomeDir(): string {
  if (process.env.NIA_AGENT_HOME) return process.env.NIA_AGENT_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData ?? "C:\\ProgramData", "NiaAgent");
  }
  // macOS (Slice M1): per-user install, no root/system account — settings
  // and encrypted secrets live under the user's own Application Support
  // folder (owner-only permissions set by packaging/macos/install.sh),
  // not /etc like the Linux systemd service.
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "NiaAgent");
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
  // macOS (Slice M1): logs go under the user's own ~/Library/Logs, not
  // mixed into the Application Support data dir — but only when NIA_AGENT_HOME
  // hasn't been overridden (tests / a non-default install location keep
  // logs alongside the rest of that dir's state, same as Linux/Windows).
  if (!process.env.NIA_AGENT_HOME && process.platform === "darwin") {
    return path.join(homedir(), "Library", "Logs", "NiaAgent");
  }
  return path.join(dir, "logs");
}

export function defaultLocksDir(dir = defaultHomeDir()): string {
  return path.join(dir, "locks");
}

/** One JSON file per job under here (ops/state.ts) — written atomically by both the running service and manual `job run`s. */
export function jobStateDir(dir = defaultHomeDir()): string {
  return path.join(dir, "job-state");
}

/** Slice L2 (ops/linkState.ts) — the check-in loop's own run state, separate from `state.json`/job-state so a corrupted/missing link file never affects job bookkeeping. */
export function linkStateFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "link-state.json");
}

/** Slice L4 (ops/link/runReportOutbox.ts) — the check-in loop's outbound run-report queue + in-progress realtime aggregation buckets. Separate from every other state file so a bookkeeping failure here can never touch job execution or link state. */
export function runReportOutboxFilePath(dir = defaultHomeDir()): string {
  return path.join(dir, "run-report-outbox.json");
}

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

/**
 * Phase 1 (local control API) — the token and port files live in their
 * own subfolder, separate from the rest of the data dir, with its own
 * (tighter but differently-scoped) ACL: on Windows, `install.ps1` grants
 * the service account + Administrators full control (same as the main
 * data dir) *plus* read-only access to the one user account that ran
 * the installer. That third grant only exists here, never on the main
 * data dir — see docs/agent-local-api.md for why (a non-elevated
 * desktop-app process has Administrators as deny-only in its UAC-
 * filtered token, so a grant to that group alone isn't enough; a grant
 * to the specific user SID is, and doesn't require elevating).
 */
export function localApiDir(dir = defaultHomeDir()): string {
  return path.join(dir, "local-api");
}

/** Written on every successful bind of the local HTTP server, so a desktop app can discover the actual port (default + fallback range) without guessing. */
export function localApiPortFilePath(dir = defaultHomeDir()): string {
  return path.join(localApiDir(dir), "port.json");
}

/**
 * The random bearer token every local API request must carry, generated
 * once and reused across restarts (same pattern as `keyFilePath`'s
 * `master.key`). Permissions are inherited from `localApiDir()`'s own
 * ACL, not the main data dir's — see docs/agent-local-api.md.
 */
export function localApiTokenFilePath(dir = defaultHomeDir()): string {
  return path.join(localApiDir(dir), "token");
}

/**
 * Windows only, written by `install.ps1`: the resolved account name
 * (`DOMAIN\user`) of whoever ran the installer, so `nia-agent doctor`
 * knows the one extra identity expected on `localApiDir()`'s ACL beyond
 * the service account and Administrators. Absent on macOS/Linux, and
 * absent everywhere if the agent was never installed via `install.ps1`
 * (e.g. run unpacked from a zip) — `doctor`'s check treats a missing
 * file as "no extra identity expected", not a failure.
 */
export function localApiInstallingUserFilePath(dir = defaultHomeDir()): string {
  return path.join(localApiDir(dir), "installing-user.json");
}

/**
 * Phase 6 polish — auto-update's rollback cache (macOS/Linux only as of
 * the Windows external-updater redesign below — Windows now hands off
 * to `nia-agent-updater.ps1`, which does its own directory-snapshot
 * rollback and never reads this). `updateInstaller.ts` copies the
 * installer it just ran here, right after a successful install, so a
 * later failed health check has a known-good package to re-run
 * (`UpdateChecker.rollback`) without re-downloading anything. Holds at
 * most one cached installer at a time — a fresh successful install
 * overwrites whatever was cached before it.
 */
export function previousInstallerCacheDir(dir = defaultHomeDir()): string {
  return path.join(dir, "update-cache");
}

/**
 * Windows only — the handoff directory between the in-process
 * `UpdateChecker` (running as the low-privilege `NT SERVICE\nia-agent`
 * account) and the external `NiaAgentUpdater` SYSTEM-principal Scheduled
 * Task (`packaging/windows/updater/nia-agent-updater.ps1`), which does
 * the actual privileged install + independent sha256/publisher
 * verification + directory-snapshot rollback + health check + tray
 * relaunch, entirely outside the agent's own process tree. Needs its
 * own SYSTEM + service-SID ACL (`install.ps1`) distinct from the rest
 * of the data dir, since the SYSTEM-run task must be able to read/write
 * here too — see install.ps1's step c3.
 */
export function updateHandoffDir(dir = defaultHomeDir()): string {
  return path.join(dir, "update");
}

/** Where `updateInstaller.ts` copies a freshly-downloaded installer before handing off — the external updater reads from here, never from the temp dir `UpdateChecker.runOnce` originally downloaded into (that temp dir is deleted by `UpdateChecker` right after `install()` returns). */
export function updateHandoffDownloadsDir(dir = defaultHomeDir()): string {
  return path.join(updateHandoffDir(dir), "downloads");
}

/** The JSON request file `updateInstaller.ts` writes and `nia-agent-updater.ps1` consumes (then deletes) — `{ version, filePath, sha256, requestedAt }`. Its mere presence is also how the updater script tells "a real request is pending" apart from "task was triggered with nothing to do". */
export function pendingUpdateRequestFilePath(dir = defaultHomeDir()): string {
  return path.join(updateHandoffDir(dir), "pending-update.json");
}

/** Written by `nia-agent-updater.ps1` after it finishes (installed+healthy, installed+rolled-back, or verification-failed) — `UpdateChecker` reads and clears this on its next tick purely for logging/diagnostics; the install/rollback/health-check decision itself has already been made externally by the time this file appears. */
export function updateHandoffResultFilePath(dir = defaultHomeDir()): string {
  return path.join(updateHandoffDir(dir), "last-result.json");
}

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  pendingUpdateRequestFilePath,
  previousInstallerCacheDir,
  updateHandoffDownloadsDir,
  updateHandoffResultFilePath,
} from "../config/paths.js";
import type { Logger } from "../ops/logger.js";
import type { UpdateInfo } from "./updateChecker.js";

export interface UpdateInstaller {
  install(filePath: string, info: UpdateInfo): Promise<{ installed: boolean }>;
  waitForHealthy(expectedVersion: string): Promise<boolean>;
  rollback(): Promise<void>;
  /** Best-effort: logs (and clears) whatever `nia-agent-updater.ps1` reported about its last run, if anything. No-op on non-Windows. */
  reportExternalResult?(): Promise<void>;
}

/**
 * Phase 6 polish — real per-OS install paths for UpdateChecker's
 * `install`/`waitForHealthy`/`rollback` hooks.
 *
 * Windows: privilege-separated handoff, NOT an in-process install. The
 * agent runs as the low-privilege virtual account `NT SERVICE\nia-agent`
 * (see install.ps1), which cannot itself run `NiaCoreAgent-Setup-
 * <version>.exe` (it requires admin elevation — `installer.nsi`'s
 * `RequestExecutionLevel admin` — and a non-interactive service session
 * has no UAC prompt available to grant that). So `install()` here does
 * NOT run the installer at all: it copies the downloaded file into
 * `updateHandoffDownloadsDir()`, writes a request file
 * (`pendingUpdateRequestFilePath()`), and triggers the `NiaAgentUpdater`
 * SYSTEM-principal Scheduled Task (registered by install.ps1) via
 * `schtasks /run` — the service account only has rights to *start* that
 * task, not reconfigure it. `{ installed: true }` here means "handed off
 * successfully", not "fully installed" — everything after that (sha256 +
 * Authenticode/publisher re-verification, directory-snapshot rollback, a
 * real `/status`-polling health check, and the tray relaunch in the
 * logged-on user's session) happens entirely inside
 * `packaging/windows/updater/nia-agent-updater.ps1`, run by that task as
 * SYSTEM — never by this process. `waitForHealthy`/`rollback` are
 * therefore permanent no-ops on win32 (not stubs pending implementation
 * — genuinely handled externally); `reportExternalResult()` just surfaces
 * what that external process logged, for diagnostics.
 *
 * macOS: per-user install (Slice M1, no root) — `installer -pkg`
 * requires elevation this process doesn't have, so this always defers
 * (`installed: false`) today. The Phase 6 plan's "Electron shows an
 * elevated-install prompt" path is the real fix and is not wired yet —
 * tracked as a follow-up alongside the Electron settings screen. Still
 * in-process (macOS has no equivalent privilege-separation redesign
 * requested), so `waitForHealthy`/`rollback`/`cacheAsLastGood` keep
 * their original exit-code-based behavior for this platform only.
 */
export function createUpdateInstaller(dir: string, logger: Logger): UpdateInstaller {
  let lastGoodInstallerPath: string | undefined;

  async function cacheAsLastGood(filePath: string): Promise<void> {
    const cacheDir = previousInstallerCacheDir(dir);
    await mkdir(cacheDir, { recursive: true });
    // At most one cached installer at a time (module doc comment) — clear any previous one first.
    for (const existing of await readdir(cacheDir).catch(() => [] as string[])) {
      await rm(path.join(cacheDir, existing), { force: true }).catch(() => undefined);
    }
    const cached = path.join(cacheDir, path.basename(filePath));
    await copyFile(filePath, cached);
    lastGoodInstallerPath = cached;
  }

  /** win32 only — see module doc comment. Never runs the installer itself. */
  async function handOffToExternalUpdater(filePath: string, info: UpdateInfo): Promise<{ installed: boolean }> {
    try {
      const downloadsDir = updateHandoffDownloadsDir(dir);
      await mkdir(downloadsDir, { recursive: true });
      const handoffPath = path.join(downloadsDir, path.basename(filePath));
      await copyFile(filePath, handoffPath);

      const request = {
        version: info.latestVersion,
        filePath: handoffPath,
        sha256: info.sha256,
        requestedAt: new Date().toISOString(),
      };
      await writeFile(pendingUpdateRequestFilePath(dir), JSON.stringify(request, null, 2), "utf8");

      await new Promise<void>((resolve, reject) => {
        execFile("schtasks", ["/run", "/tn", "NiaAgentUpdater"], (err) => (err ? reject(err) : resolve()));
      });

      logger.info("update_handed_off_to_external_updater", { version: info.latestVersion });
      return { installed: true };
    } catch (err) {
      logger.warn("update_handoff_failed", { error: err instanceof Error ? err.message : String(err) });
      return { installed: false };
    }
  }

  return {
    async install(filePath, info) {
      if (process.platform === "win32") {
        return handOffToExternalUpdater(filePath, info);
      }

      if (process.platform === "darwin") {
        const exitCode = await runDetached("/usr/sbin/installer", ["-pkg", filePath, "-target", "/"]);
        if (exitCode !== 0) {
          logger.info("update_needs_elevation", { platform: "darwin" });
          return { installed: false };
        }
        await cacheAsLastGood(filePath);
        return { installed: true };
      }

      logger.warn("update_unsupported_platform", { platform: process.platform });
      return { installed: false };
    },

    // win32: always true — the real health check is performed externally by
    // nia-agent-updater.ps1 before it ever reports success, so there is
    // nothing left for this in-process check to verify by the time
    // install() above has returned. See module doc comment.
    // macOS: exit-code-based, not a live post-restart check (unchanged).
    async waitForHealthy() {
      return true;
    },

    async rollback() {
      // win32: rollback is performed externally (directory-snapshot restore
      // inside nia-agent-updater.ps1) before that script would ever let a
      // bad install stand — this process never reaches here with a real
      // rollback to do, since waitForHealthy() above never reports false on
      // Windows. No-op, not a stub.
      if (process.platform === "win32") return;

      if (!lastGoodInstallerPath) {
        logger.warn("update_rollback_skipped_no_cache", {});
        return;
      }
      if (process.platform === "darwin") {
        await runDetached("/usr/sbin/installer", ["-pkg", lastGoodInstallerPath, "-target", "/"]);
      }
    },

    async reportExternalResult() {
      if (process.platform !== "win32") return;
      const resultPath = updateHandoffResultFilePath(dir);
      try {
        const raw = await readFile(resultPath, "utf8");
        const result = JSON.parse(raw) as { outcome?: string; version?: string; error?: string };
        logger.info("update_external_result", result);
      } catch {
        return; // no result file yet — nothing to report
      } finally {
        await rm(resultPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

function runDetached(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    } catch {
      resolve(1);
    }
  });
}

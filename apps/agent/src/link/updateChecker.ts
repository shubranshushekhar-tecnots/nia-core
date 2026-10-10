import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../ops/logger.js";

/**
 * Phase 6 polish — auto-update. Mirrors `packages/schemas/src/
 * agentVersion.ts`'s `compareAgentVersions`/`isNewerVersion` exactly
 * (numeric dot-separated compare, unparseable segment treated as 0).
 * Duplicated rather than imported: apps/agent deliberately has no
 * dependency on @nia/schemas (see link/transport.ts's doc comment on
 * AgentConnectionReport for the same convention) — keep this in sync by
 * hand if that file's comparator ever changes.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const partsA = candidate.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i] ?? 0;
    const bi = partsB[i] ?? 0;
    if (ai !== bi) return ai - bi > 0;
  }
  return false;
}

export interface UpdateInfo {
  latestVersion: string;
  url: string;
  sha256: string;
  minVersion: string;
}

/** Surfaced to the UI (localApi/routes/status.ts) so the desktop app can show "Update available"/"Update ready to install". */
export interface PendingUpdate {
  version: string;
  /** True once the update has been downloaded + checksum-verified but `install()` deliberately deferred (e.g. needs elevation) — the desktop app can prompt the user to finish it manually. False while still only "detected" or mid-attempt. */
  readyToInstall: boolean;
}

/** The HTTP half (services/agent-bridge's `GET /agent-api/update`) — isolated behind an interface, same convention as link/transport.ts's AgentTransport, so updateChecker.ts never touches undici directly and is fully unit-testable. */
export interface UpdateClient {
  /** Returns `undefined` on any failure (network, 401, 404, malformed body) — treated the same as "nothing to do" by UpdateChecker, never thrown. */
  fetchUpdate(agentVersion: string): Promise<UpdateInfo | undefined>;
  /** Downloads `url` to `destPath`. Throws on failure. */
  download(url: string, destPath: string): Promise<void>;
}

export interface UpdateCheckerOptions {
  client: UpdateClient;
  agentVersion: string;
  logger: Logger;
  /** True while any scheduled job is in flight — installing is deferred until this returns false, so an update never interrupts a running sync. Re-read on every tick (not cached), same convention as isAutoUpdateEnabled. */
  isJobRunning: () => boolean;
  /** Reads the live config on every tick — matches CheckInLoop/JobScheduler's "re-read config each time" convention, so toggling the setting takes effect on the next tick without a restart. */
  isAutoUpdateEnabled: () => boolean;
  /**
   * Performs the actual platform install from a verified, downloaded
   * file. Returns `{ installed: false }` (not a throw) when the install
   * was deliberately deferred — e.g. it needs elevation the running
   * process doesn't have — so UpdateChecker can skip the health-check/
   * rollback cycle for a no-op instead of treating it as a failure.
   */
  install: (filePath: string, info: UpdateInfo) => Promise<{ installed: boolean }>;
  /** Only called when `install` returned `{ installed: true }`. Returns false to trigger rollback. */
  waitForHealthy: (expectedVersion: string) => Promise<boolean>;
  /** Only called after a failed health check. Best-effort — UpdateChecker logs but does not rethrow if this itself fails. */
  rollback: () => Promise<void>;
  /** Optional — surfaces diagnostics from an external updater process (Windows's privilege-separated `nia-agent-updater.ps1`, run outside this process). Called once per tick, before the check-for-update step, regardless of whether this tick finds anything new. Best-effort; failures are swallowed, never thrown. */
  reportExternalResult?: () => Promise<void>;
  /** Base interval between checks. Defaults to 4 hours. */
  intervalMs?: number;
  /** Random jitter added on top of `intervalMs` (uniform in `[0, jitterMs)`) so many installs don't all poll at once. Defaults to 10 minutes. */
  jitterMs?: number;
}

const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_JITTER_MS = 10 * 60 * 1000;

/**
 * Periodic, jittered "is there a newer agent build" check (Phase 6 plan
 * §2) — modeled on CheckInLoop's own timer lifecycle (`start`/`stop`,
 * `setTimeout`-based, `.unref()`'d so it never keeps the process alive
 * on its own), but without CheckInLoop's long-poll/backoff machinery
 * since this is a plain periodic poll, not a held connection.
 *
 * `tick()` is also exported for a local-api "check now" route
 * (`POST /update/check`) to call directly, outside the timer.
 */
export class UpdateChecker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private pendingUpdate: PendingUpdate | undefined;

  constructor(private readonly options: UpdateCheckerOptions) {}

  start(): void {
    this.stopped = false;
    this.scheduleNext(this.nextDelay());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The most recent known "there's a newer build" state — `undefined` once up to date (or never checked yet). Read by localApi/routes/status.ts on every `/status` request; never cached by the caller. */
  getPendingUpdate(): PendingUpdate | undefined {
    return this.pendingUpdate;
  }

  private nextDelay(): number {
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const jitter = this.options.jitterMs ?? DEFAULT_JITTER_MS;
    return interval + Math.floor(Math.random() * jitter);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => void this.tick(), delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** Runs one check-and-maybe-install cycle immediately, then reschedules the timer. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.options.logger.warn("update_check_failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.scheduleNext(this.nextDelay());
    }
  }

  private async runOnce(): Promise<void> {
    if (this.options.reportExternalResult) {
      await this.options.reportExternalResult().catch(() => undefined);
    }

    if (!this.options.isAutoUpdateEnabled()) return;

    const info = await this.options.client.fetchUpdate(this.options.agentVersion);
    if (!info) return;

    // No-downgrade guard: also covers "already on the latest version" (equal is not newer).
    if (!isNewerVersion(info.latestVersion, this.options.agentVersion)) {
      this.pendingUpdate = undefined; // caught up (or somehow ahead) -- clear any stale pending-update state
      return;
    }

    // A newer build exists -- surface it even if the rest of this tick defers/fails. Keeps a
    // same-version readyToInstall from a prior tick, resets it for a genuinely new version.
    this.pendingUpdate = { version: info.latestVersion, readyToInstall: this.pendingUpdate?.version === info.latestVersion ? this.pendingUpdate.readyToInstall : false };

    if (this.options.isJobRunning()) {
      this.options.logger.info("update_deferred_job_running", { latestVersion: info.latestVersion });
      return;
    }

    const dir = await mkdtemp(path.join(tmpdir(), "nia-agent-update-"));
    try {
      const fileName = safeFileNameFromUrl(info.url);
      const filePath = path.join(dir, fileName);
      await this.options.client.download(info.url, filePath);

      const matches = await verifySha256(filePath, info.sha256);
      if (!matches) {
        this.options.logger.warn("update_checksum_mismatch", { latestVersion: info.latestVersion });
        return;
      }

      const { installed } = await this.options.install(filePath, info);
      if (!installed) {
        this.options.logger.info("update_install_deferred", { latestVersion: info.latestVersion });
        this.pendingUpdate = { version: info.latestVersion, readyToInstall: true };
        return;
      }

      const healthy = await this.options.waitForHealthy(info.latestVersion);
      if (!healthy) {
        this.options.logger.warn("update_health_check_failed_rolling_back", { latestVersion: info.latestVersion });
        try {
          await this.options.rollback();
        } catch (err) {
          this.options.logger.warn("update_rollback_failed", { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      this.options.logger.info("update_applied", { latestVersion: info.latestVersion });
      this.pendingUpdate = undefined; // fully applied -- nothing left pending
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function safeFileNameFromUrl(url: string): string {
  try {
    const base = path.basename(new URL(url).pathname);
    return base || "update.bin";
  } catch {
    return "update.bin";
  }
}

async function verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex").toLowerCase() === expectedHex.toLowerCase();
}

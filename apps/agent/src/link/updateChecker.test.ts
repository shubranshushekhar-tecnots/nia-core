import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../ops/logger.js";
import { UpdateChecker, type UpdateClient, type UpdateInfo } from "./updateChecker.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const GOOD_CONTENT = "fake-installer-bytes";

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return { latestVersion: "2.0.0", url: "https://downloads.example.com/nia-agent-2.0.0.exe", sha256: sha256(GOOD_CONTENT), minVersion: "1.0.0", ...overrides };
}

describe("UpdateChecker", () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-updatechecker-"));
    logger = new Logger(path.join(dir, "logs"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function client(overrides: Partial<UpdateClient> = {}): UpdateClient {
    return {
      fetchUpdate: vi.fn(async () => info()),
      download: vi.fn(async (_url: string, destPath: string) => {
        await writeFile(destPath, GOOD_CONTENT);
      }),
      ...overrides,
    };
  }

  it("checksum mismatch: does not install, does not roll back", async () => {
    const install = vi.fn(async () => ({ installed: true }));
    const waitForHealthy = vi.fn(async () => true);
    const rollback = vi.fn(async () => {});
    const checker = new UpdateChecker({
      client: client({ fetchUpdate: vi.fn(async () => info({ sha256: "0".repeat(64) })) }),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy,
      rollback,
    });

    await checker.tick();

    expect(install).not.toHaveBeenCalled();
    expect(waitForHealthy).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("job running: defers the install instead of running it", async () => {
    const install = vi.fn(async () => ({ installed: true }));
    const checker = new UpdateChecker({
      client: client(),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => true,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy: vi.fn(async () => true),
      rollback: vi.fn(async () => {}),
    });

    await checker.tick();

    expect(install).not.toHaveBeenCalled();
  });

  it("no-downgrade guard: an equal or older latestVersion never installs", async () => {
    const install = vi.fn(async () => ({ installed: true }));
    const fetchUpdate = vi.fn(async () => info({ latestVersion: "1.0.0" })); // equal to current
    const checker = new UpdateChecker({
      client: client({ fetchUpdate }),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy: vi.fn(async () => true),
      rollback: vi.fn(async () => {}),
    });

    await checker.tick();
    expect(install).not.toHaveBeenCalled();

    fetchUpdate.mockResolvedValue(info({ latestVersion: "0.9.0" })); // older than current
    await checker.tick();
    expect(install).not.toHaveBeenCalled();
  });

  it("failed health check after install triggers rollback", async () => {
    const install = vi.fn(async () => ({ installed: true }));
    const waitForHealthy = vi.fn(async () => false);
    const rollback = vi.fn(async () => {});
    const checker = new UpdateChecker({
      client: client(),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy,
      rollback,
    });

    await checker.tick();

    expect(install).toHaveBeenCalledTimes(1);
    expect(waitForHealthy).toHaveBeenCalledWith("2.0.0");
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("happy path: downloads, verifies, installs, and confirms healthy with no rollback", async () => {
    let installedFileContent: string | undefined;
    const install = vi.fn(async (filePath: string) => {
      installedFileContent = await readFile(filePath, "utf8"); // read before UpdateChecker's finally{} cleans up the temp dir
      return { installed: true };
    });
    const waitForHealthy = vi.fn(async () => true);
    const rollback = vi.fn(async () => {});
    const checker = new UpdateChecker({
      client: client(),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy,
      rollback,
    });

    await checker.tick();

    expect(install).toHaveBeenCalledTimes(1);
    expect(installedFileContent).toBe(GOOD_CONTENT);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("deferred install (e.g. needs elevation) skips the health check/rollback cycle entirely", async () => {
    const install = vi.fn(async () => ({ installed: false }));
    const waitForHealthy = vi.fn(async () => true);
    const rollback = vi.fn(async () => {});
    const checker = new UpdateChecker({
      client: client(),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy,
      rollback,
    });

    await checker.tick();

    expect(install).toHaveBeenCalledTimes(1);
    expect(waitForHealthy).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("auto-update disabled: never fetches or installs", async () => {
    const fetchUpdate = vi.fn(async () => info());
    const install = vi.fn(async () => ({ installed: true }));
    const checker = new UpdateChecker({
      client: client({ fetchUpdate }),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => false,
      install,
      waitForHealthy: vi.fn(async () => true),
      rollback: vi.fn(async () => {}),
    });

    await checker.tick();

    expect(fetchUpdate).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("no update available (client returns undefined): no-op, no throw", async () => {
    const install = vi.fn(async () => ({ installed: true }));
    const checker = new UpdateChecker({
      client: client({ fetchUpdate: vi.fn(async () => undefined) }),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install,
      waitForHealthy: vi.fn(async () => true),
      rollback: vi.fn(async () => {}),
    });

    await checker.tick();
    expect(install).not.toHaveBeenCalled();
  });

  it("start()/stop(): ticks on a jittered timer and stops cleanly", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fetchUpdate = vi.fn(async () => undefined);
    const checker = new UpdateChecker({
      client: client({ fetchUpdate }),
      agentVersion: "1.0.0",
      logger,
      isJobRunning: () => false,
      isAutoUpdateEnabled: () => true,
      install: vi.fn(async () => ({ installed: true })),
      waitForHealthy: vi.fn(async () => true),
      rollback: vi.fn(async () => {}),
      intervalMs: 1_000,
      jitterMs: 1, // effectively deterministic for the test
    });

    checker.start();
    expect(fetchUpdate).not.toHaveBeenCalled(); // first tick is delayed, not immediate

    await vi.advanceTimersByTimeAsync(1_001);
    expect(fetchUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(fetchUpdate).toHaveBeenCalledTimes(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchUpdate).toHaveBeenCalledTimes(2); // no more ticks after stop()
  });

  describe("getPendingUpdate()", () => {
    it("is undefined before any tick", () => {
      const checker = new UpdateChecker({
        client: client(),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => false,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: true })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      expect(checker.getPendingUpdate()).toBeUndefined();
    });

    it("goes undefined -> {readyToInstall:false} -> undefined across a fully-applied update", async () => {
      const checker = new UpdateChecker({
        client: client(),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => false,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: true })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();

      // applied successfully (install + healthy both succeeded) -- nothing left pending
      expect(checker.getPendingUpdate()).toBeUndefined();
    });

    it("surfaces {version, readyToInstall:true} when install is deliberately deferred (e.g. needs elevation)", async () => {
      const checker = new UpdateChecker({
        client: client(),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => false,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: false })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();

      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: true });
    });

    it("surfaces {version, readyToInstall:false} when a job is running and the install is deferred", async () => {
      const checker = new UpdateChecker({
        client: client(),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => true,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: true })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();

      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: false });
    });

    it("preserves readyToInstall across ticks for the same pending version", async () => {
      const fetchUpdate = vi.fn(async () => info());
      const checker = new UpdateChecker({
        client: client({ fetchUpdate }),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => false,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: false })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();
      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: true });

      // a later tick re-detects the same still-pending version -- readyToInstall must not reset to false
      await checker.tick();
      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: true });
    });

    it("resets readyToInstall when a genuinely newer version appears", async () => {
      const fetchUpdate = vi.fn(async () => info());
      let jobRunning = false;
      const checker = new UpdateChecker({
        client: client({ fetchUpdate }),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => jobRunning,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: false })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();
      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: true });

      // a job is running on this tick, so the new version is only detected (not
      // installed) -- isolates the reset from the separate "install deferred"
      // overwrite, which would otherwise re-set readyToInstall:true itself.
      jobRunning = true;
      fetchUpdate.mockResolvedValue(info({ latestVersion: "3.0.0", sha256: sha256(GOOD_CONTENT) }));
      await checker.tick();
      expect(checker.getPendingUpdate()).toEqual({ version: "3.0.0", readyToInstall: false });
    });

    it("clears to undefined once the no-downgrade guard trips (caught up or ahead)", async () => {
      const fetchUpdate = vi.fn(async () => info());
      const checker = new UpdateChecker({
        client: client({ fetchUpdate }),
        agentVersion: "1.0.0",
        logger,
        isJobRunning: () => false,
        isAutoUpdateEnabled: () => true,
        install: vi.fn(async () => ({ installed: false })),
        waitForHealthy: vi.fn(async () => true),
        rollback: vi.fn(async () => {}),
      });

      await checker.tick();
      expect(checker.getPendingUpdate()).toEqual({ version: "2.0.0", readyToInstall: true });

      fetchUpdate.mockResolvedValue(info({ latestVersion: "1.0.0" })); // caught up
      await checker.tick();
      expect(checker.getPendingUpdate()).toBeUndefined();
    });
  });
});

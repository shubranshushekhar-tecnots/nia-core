import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// apps/agent root (two levels up from src/cli/).
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const tsxBin = path.join(agentDir, "node_modules", ".bin", "tsx");
const entryPoint = path.join(agentDir, "src", "index.ts");

describe("CLI startup (real process, same entrypoint as `pnpm run dev`)", () => {
  // Regression test for the B2 cron-parser named-import crash: the whole
  // CLI failed to even load (SyntaxError at module-eval time, before any
  // command ran), because `scheduler/cronSchedule.ts` is reached via
  // index.ts's top-level import chain. A unit test of cronSchedule.ts in
  // isolation would not have caught this — vitest's own module transform
  // tolerates the broken named import, only a real `node`/`tsx` process
  // does not. Starting the real CLI as a child process is the only way
  // to reproduce and guard against this class of bug.
  it("`tsx src/index.ts version` exits 0", async () => {
    const { stdout } = await execFileAsync(tsxBin, [entryPoint, "version"], { cwd: agentDir });
    expect(stdout).toContain(process.version);
  });

  let homeDir: string | undefined;
  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  // Regression test for the unref/event-loop bug found during Phase B's
  // real-run verification: `agent start` returned almost immediately
  // (exit 0) instead of staying resident until interrupted, because
  // nothing in the process refed Node's event loop while idle — see
  // agentLoop.ts's `keepAlive` handle and jobScheduler.ts's `start()`/
  // `scheduleNext()` (no longer `.unref()`'d). A fake-timers unit test
  // of JobScheduler in isolation would not catch this class of bug
  // either — it's only observable in a real process's real event loop.
  // Deliberately run with zero jobs configured (a fresh, empty
  // NIA_AGENT_HOME): the bug reproduced identically with or without
  // jobs, and the fix must not depend on a job's own timer existing.
  it("`tsx src/index.ts start` with no jobs stays running until interrupted, then exits 0", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "nia-agent-cli-start-"));
    const child = spawn(tsxBin, [entryPoint, "start"], {
      cwd: agentDir,
      env: { ...process.env, NIA_AGENT_HOME: homeDir },
    });

    let exited = false;
    let exitCode: number | null = null;
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(exited).toBe(false); // still running 2s in — not the unref bug

    child.kill("SIGINT");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(exitCode).toBe(0);
  }, 15_000);
});

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
});

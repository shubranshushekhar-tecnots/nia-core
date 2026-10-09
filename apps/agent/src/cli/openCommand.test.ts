import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../ops/logger.js";
import { createLocalApiServer, type LocalApiServerHandle } from "../localApi/server.js";
import { buildOtcRoutes } from "../localApi/routes/uiAuth.js";
import { loadOrCreateApiToken } from "../localApi/authToken.js";

const execFileCalls: Array<[string, string[]]> = [];

vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    execFileCalls.push([file, args]);
    cb(null, { stdout: "", stderr: "" });
  },
}));

// Imported after the mock so openCommand.ts's `import { execFile } from
// "node:child_process"` resolves to the mocked version above.
const { runOpen, AgentNotRunningError } = await import("./openCommand.js");

describe("runOpen", () => {
  let dir: string;
  let handle: LocalApiServerHandle | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-open-"));
    execFileCalls.length = 0;
  });

  afterEach(async () => {
    await handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws AgentNotRunningError when there is no port file (agent not started)", async () => {
    await expect(runOpen(dir)).rejects.toThrow(AgentNotRunningError);
  });

  it("mints an OTC and opens the browser at /?otc=<code>, without the real token ever appearing in the URL", async () => {
    const token = loadOrCreateApiToken(dir);
    handle = await createLocalApiServer({ dir, apiToken: token, routes: buildOtcRoutes(), logger: new Logger(dir) });

    await runOpen(dir);

    expect(execFileCalls).toHaveLength(1);
    const [, args] = execFileCalls[0]!;
    const url = args[args.length - 1]!;
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${handle!.port}/\\?otc=[0-9a-f]+$`));
    expect(url).not.toContain(token);
  });

  it("throws AgentNotRunningError when the port file points at nothing listening", async () => {
    fs.mkdirSync(path.join(dir, "local-api"), { recursive: true });
    fs.writeFileSync(path.join(dir, "local-api", "port.json"), JSON.stringify({ port: 1, startedAt: new Date().toISOString() }));
    loadOrCreateApiToken(dir);

    await expect(runOpen(dir)).rejects.toThrow(AgentNotRunningError);
  });
});

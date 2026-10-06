import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../config/store.js";
import type { LinkConfig } from "../config/types.js";
import { LinkWatcher } from "./linkWatcher.js";

describe("LinkWatcher", () => {
  let dir: string;
  let watcher: LinkWatcher | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-linkwatcher-"));
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("notices pair within a few seconds, with no restart", async () => {
    const changes: (LinkConfig | undefined)[] = [];
    watcher = new LinkWatcher({ dir, pollMs: 20, onChange: (link) => changes.push(link) });
    watcher.start();

    // Starting unpaired must not itself fire onChange.
    await sleep(60);
    expect(changes).toHaveLength(0);

    // Simulate `nia-agent pair` writing link into config while the service is already running.
    const link: LinkConfig = { platformUrl: "http://localhost:4040", agentId: "agent-1", agentKeyRef: "ref-1" };
    saveConfig({ ...loadConfig(dir), link }, dir);

    await waitFor(() => changes.length >= 1, 2_000);
    expect(changes[0]).toEqual(link);
  });

  it("notices unpair within a few seconds, with no restart", async () => {
    const link: LinkConfig = { platformUrl: "http://localhost:4040", agentId: "agent-1", agentKeyRef: "ref-1" };
    saveConfig({ ...loadConfig(dir), link }, dir);

    const changes: (LinkConfig | undefined)[] = [];
    watcher = new LinkWatcher({ dir, pollMs: 20, onChange: (l) => changes.push(l) });
    watcher.start();

    // Simulate `nia-agent unpair` clearing link from config while the service is already running.
    const { link: _link, ...rest } = loadConfig(dir);
    saveConfig(rest, dir);

    await waitFor(() => changes.length >= 1, 2_000);
    expect(changes[0]).toBeUndefined();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

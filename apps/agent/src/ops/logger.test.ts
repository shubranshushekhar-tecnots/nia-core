import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "./logger.js";

describe("Logger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-logger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends structured JSON lines", async () => {
    const logger = new Logger(dir);
    logger.info("sync.complete", { connectionId: "conn-1", rows: 42 });
    logger.error("sync.failed", { connectionId: "conn-2", error: "timeout" });

    const content = await readFile(path.join(dir, "agent.log"), "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ level: "info", event: "sync.complete", connectionId: "conn-1", rows: 42 }),
      expect.objectContaining({ level: "error", event: "sync.failed", connectionId: "conn-2", error: "timeout" }),
    ]);
  });

  it("rotates to agent.log.1 once the size threshold is crossed", async () => {
    const logger = new Logger(dir, { maxBytes: 10, maxBackups: 2 });
    logger.info("first", {});
    logger.info("second", {});
    logger.info("third", {});

    const files = (await readdir(dir)).sort();
    expect(files).toContain("agent.log");
    expect(files).toContain("agent.log.1");
  });

  it("caps the number of retained backups", async () => {
    const logger = new Logger(dir, { maxBytes: 1, maxBackups: 2 });
    for (let i = 0; i < 10; i++) logger.info(`event-${i}`, {});

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["agent.log", "agent.log.1", "agent.log.2"]);
  });

  it("picks up the existing file size across instances instead of mis-rotating immediately", async () => {
    const first = new Logger(dir, { maxBytes: 1000 });
    first.info("a", {});
    const sizeAfterFirst = (await readFile(path.join(dir, "agent.log"), "utf8")).length;

    const second = new Logger(dir, { maxBytes: 1000 });
    second.info("b", {});

    const files = await readdir(dir);
    expect(files).toEqual(["agent.log"]);
    const finalContent = await readFile(path.join(dir, "agent.log"), "utf8");
    expect(finalContent.length).toBeGreaterThan(sizeAfterFirst);
  });
});

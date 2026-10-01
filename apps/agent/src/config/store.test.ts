import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigValidationError, findConnection, loadConfig, removeConnection, saveConfig, upsertConnection } from "./store.js";
import { emptyConfig } from "./types.js";
import type { ConnectionEntry } from "./types.js";

const entry: ConnectionEntry = {
  id: "conn-1",
  label: "SummitERP_A",
  sqlserver: { host: "localhost", database: "SummitERP_A" },
  planometry: { baseUrl: "https://planometry.example.com" },
  credentialRef: "cred-ref",
  agentKeyRef: "key-ref",
};

describe("config store", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-config-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty config when no file exists yet", () => {
    expect(loadConfig(dir)).toEqual(emptyConfig());
  });

  it("round-trips a saved config", () => {
    const config = upsertConnection(emptyConfig(), entry);
    saveConfig(config, dir);
    expect(loadConfig(dir)).toEqual(config);
  });

  it("writes the config file with owner-only permissions", () => {
    saveConfig(emptyConfig(), dir);
    const mode = fs.statSync(path.join(dir, "agent.config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects an unsupported version", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.config.json"), JSON.stringify({ version: 99, connections: [] }));
    expect(() => loadConfig(dir)).toThrow(ConfigValidationError);
  });

  it("rejects invalid JSON", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.config.json"), "{not json");
    expect(() => loadConfig(dir)).toThrow(ConfigValidationError);
  });

  it("round-trips an optional monitoring config", () => {
    const config = { ...emptyConfig(), monitoring: { heartbeatUrl: "https://monitor.example.com/ingest", intervalSeconds: 300 } };
    saveConfig(config, dir);
    expect(loadConfig(dir)).toEqual(config);
  });

  it("upserts and removes a connection", () => {
    let config = upsertConnection(emptyConfig(), entry);
    expect(findConnection(config, "conn-1")).toEqual(entry);

    const updated = { ...entry, label: "renamed" };
    config = upsertConnection(config, updated);
    expect(findConnection(config, "conn-1")?.label).toBe("renamed");
    expect(config.connections).toHaveLength(1);

    config = removeConnection(config, "conn-1");
    expect(findConnection(config, "conn-1")).toBeUndefined();
  });
});

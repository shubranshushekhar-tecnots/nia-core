import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection, listConnections, removeConnection } from "./connectionCommands.js";
import { loadConfig } from "../config/store.js";
import { LocalSecretStore } from "../secrets/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";

describe("connection commands", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-cli-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds a connection, storing credentials in the secret store and only refs in config", () => {
    const entry = addConnection(
      {
        id: "conn-1",
        label: "SummitERP_A",
        host: "sql.gms.local",
        database: "SummitERP_A",
        user: "sa",
        password: "s3cret",
        planometryBaseUrl: "https://planometry.example.com",
        agentKey: "agent-key-value",
      },
      dir,
    );

    const config = loadConfig(dir);
    expect(config.connections).toHaveLength(1);
    expect(JSON.stringify(config)).not.toContain("s3cret");
    expect(JSON.stringify(config)).not.toContain("agent-key-value");

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    expect(secrets.get(entry.credentialRef)).toEqual({ user: "sa", password: "s3cret" });
    expect(secrets.get(entry.agentKeyRef)).toEqual({ agentKey: "agent-key-value" });
  });

  it("lists added connections", () => {
    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", planometryBaseUrl: "https://x", agentKey: "k" },
      dir,
    );
    expect(listConnections(dir).map((c) => c.id)).toEqual(["conn-1"]);
  });

  it("removes a connection and its secrets", () => {
    const entry = addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", planometryBaseUrl: "https://x", agentKey: "k" },
      dir,
    );
    expect(removeConnection("conn-1", dir)).toBe(true);
    expect(listConnections(dir)).toHaveLength(0);

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    expect(secrets.get(entry.credentialRef)).toBeNull();
  });

  it("returns false removing an unknown connection", () => {
    expect(removeConnection("nope", dir)).toBe(false);
  });
});

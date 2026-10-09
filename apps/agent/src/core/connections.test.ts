import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection, ConnectionInUseError, InvalidTimeZoneError, listConnections, removeConnection } from "./connections.js";
import { loadConfig, saveConfig, upsertJob } from "../config/store.js";
import type { SyncJobEntry } from "../config/types.js";
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
        sourceTimeZone: "UTC",
      },
      dir,
    );

    const config = loadConfig(dir);
    expect(config.connections).toHaveLength(1);
    expect(JSON.stringify(config)).not.toContain("s3cret");

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    expect(secrets.get(entry.credentialRef)).toEqual({ user: "sa", password: "s3cret" });
  });

  it("lists added connections", () => {
    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC" },
      dir,
    );
    expect(listConnections(dir).map((c) => c.id)).toEqual(["conn-1"]);
  });

  it("removes a connection and its secrets", () => {
    const entry = addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC" },
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

  it("rejects an invalid IANA time zone", () => {
    expect(() =>
      addConnection(
        { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "Not/AZone" },
        dir,
      ),
    ).toThrow(InvalidTimeZoneError);
  });

  it("refuses to remove a connection while a job uses it", () => {
    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC" },
      dir,
    );
    const job: SyncJobEntry = {
      id: "job-1",
      name: "Sales export",
      connectionId: "conn-1",
      sourceTable: "dbo.Sales",
      targetUrl: "https://planometry.example.com/t/abc",
      pushKeyRef: "push-key-ref",
      strategy: "replace",
      mapping: [{ source: "Id", target: "Id" }],
      targetSchemaSnapshot: { columns: [{ name: "Id", type: "Number", isKey: true }], keyColumns: ["Id"] },
      onNullKey: "stop",
      allowEmptyReplace: false,
    };
    saveConfig(upsertJob(loadConfig(dir), job), dir);

    expect(() => removeConnection("conn-1", dir)).toThrow(ConnectionInUseError);
    expect(listConnections(dir)).toHaveLength(1);
  });
});

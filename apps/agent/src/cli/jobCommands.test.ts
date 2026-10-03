import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog, CatalogTable } from "@nia/extract";
import type { SchemaColumn } from "../planometry/types.js";

const { connectMock, introspectCatalogMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  introspectCatalogMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", () => ({
  connect: connectMock,
  introspectCatalog: introspectCatalogMock,
}));

const { addConnection } = await import("./connectionCommands.js");
const { addJob, listJobs, removeJob, testJob, updateJob } = await import("./jobCommands.js");
const { secretsFilePath, configFilePath } = await import("../config/paths.js");
const { loadOrCreateMasterKey } = await import("../secrets/keyfile.js");
const { LocalSecretStore } = await import("../secrets/store.js");
const { FakePlanometryServer } = await import("../testing/fakePlanometryServer.js");

function sourceCatalog(table: CatalogTable): Catalog {
  return { generatedAt: new Date().toISOString(), sourceTimeZone: "UTC", tables: [table] };
}

function sourceTable(name: string, columns: CatalogTable["columns"], excluded: CatalogTable["excluded"] = []): CatalogTable {
  return { name, kind: "table", columns, excluded };
}

describe("job commands", () => {
  let dir: string;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-jobs-"));
    connectMock.mockReset();
    introspectCatalogMock.mockReset();
    connectMock.mockResolvedValue({ close: async () => {} });
    server = await FakePlanometryServer.start();

    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC", agentKey: "k" },
      dir,
    );
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("job add", () => {
    it("auto-matches by norm()", async () => {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable("dbo.Sales", [
            { name: "Id", type: "number", nullable: false },
            { name: "First_Name", type: "text", nullable: true },
          ]),
        ),
      );
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "FirstName", type: "Text", isKey: false },
        ],
      });

      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      expect(result.ok).toBe(true);
      expect(result.job!.mapping).toEqual([
        { source: "Id", target: "Id" },
        { source: "First_Name", target: "FirstName" },
      ]);
    });

    it("--map overrides auto-match", async () => {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable("dbo.Sales", [
            { name: "Id", type: "number", nullable: false },
            { name: "LegacyName", type: "text", nullable: true },
            { name: "FirstName", type: "text", nullable: true },
          ]),
        ),
      );
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "FirstName", type: "Text", isKey: false },
        ],
      });

      const result = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [{ source: "LegacyName", target: "FirstName" }],
        },
        {},
        dir,
      );

      expect(result.ok).toBe(true);
      expect(result.job!.mapping).toContainEqual({ source: "LegacyName", target: "FirstName" });
    });

    it("lists an unmapped non-key target column as sent as null", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "Notes", type: "Text", isKey: false },
        ],
      });

      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      expect(result.ok).toBe(true);
      expect(result.sentAsNull).toEqual(["Notes"]);
      expect(result.job!.mapping.some((p) => p.target === "Notes")).toBe(false);
    });

    it("is refused when a key column is unmapped", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Name", type: "text", nullable: true }])));
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "Name", type: "Text", isKey: false },
        ],
      });

      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes('target key column "Id" must be mapped'))).toBe(true);
      expect(listJobs(dir)).toHaveLength(0);
    });

    it("is refused when two sources map to one target", async () => {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable("dbo.Sales", [
            { name: "Id", type: "number", nullable: false },
            { name: "A", type: "text", nullable: true },
            { name: "B", type: "text", nullable: true },
          ]),
        ),
      );
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "Name", type: "Text", isKey: false },
        ],
      });

      const result = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [
            { source: "A", target: "Name" },
            { source: "B", target: "Name" },
          ],
        },
        {},
        dir,
      );

      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("more than one source column is mapped to the same target column"))).toBe(true);
    });

    it("is refused for an unknown target column", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: [{ name: "Id", type: "Number", isKey: true }] });

      const result = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [{ source: "Id", target: "DoesNotExist" }],
        },
        {},
        dir,
      );

      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes('target column "DoesNotExist" does not exist'))).toBe(true);
    });

    it("is refused for an unknown or excluded source column", async () => {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable(
            "dbo.Sales",
            [
              { name: "Id", type: "number", nullable: false },
              { name: "Name", type: "text", nullable: false },
            ],
            [{ name: "Blob", nativeType: "varbinary(max)", reason: "binary types are excluded" }],
          ),
        ),
      );
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "Name", type: "Text", isKey: false },
          { name: "Avatar", type: "Text", isKey: false },
        ],
      });

      const unknown = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [{ source: "Ghost", target: "Name" }],
        },
        {},
        dir,
      );
      expect(unknown.ok).toBe(false);
      expect(unknown.errors!.some((e) => e.includes('source column "Ghost" does not exist in the catalog'))).toBe(true);

      const excluded = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [{ source: "Blob", target: "Avatar" }],
        },
        {},
        dir,
      );
      expect(excluded.ok).toBe(false);
      expect(excluded.errors!.some((e) => e.includes('source column "Blob" is of an excluded type'))).toBe(true);
    });

    it("is refused for a disallowed type pair", async () => {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable("dbo.Sales", [
            { name: "Id", type: "number", nullable: false },
            { name: "Description", type: "text", nullable: true },
          ]),
        ),
      );
      const handle = server.createTable({
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "Amount", type: "Number", isKey: false },
        ],
      });

      const result = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: handle.pushKey,
          mapOverrides: [{ source: "Description", target: "Amount" }],
        },
        {},
        dir,
      );

      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("cannot be mapped to target column"))).toBe(true);
    });

    it("a wrong key (401) saves no job and no secret", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: [{ name: "Id", type: "Number", isKey: true }] });

      const secretsBefore = fs.readFileSync(secretsFilePath(dir), "utf8");

      const result = await addJob(
        {
          name: "Sales",
          connectionId: "conn-1",
          sourceTable: "dbo.Sales",
          targetUrl: handle.tableUrl,
          pushKey: "wrong-key",
          mapOverrides: [],
        },
        {},
        dir,
      );

      expect(result.ok).toBe(false);
      expect(listJobs(dir)).toHaveLength(0);
      expect(fs.readFileSync(secretsFilePath(dir), "utf8")).toBe(secretsBefore);
    });

    it("has no --target-key flag anywhere in the CLI", () => {
      const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
      const indexSource = fs.readFileSync(indexPath, "utf8");
      expect(indexSource).not.toMatch(/target-key/);
    });

    it("the saved config file does not contain the push key", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: [{ name: "Id", type: "Number", isKey: true }] });

      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      expect(result.ok).toBe(true);
      const rawConfig = fs.readFileSync(configFilePath(dir), "utf8");
      expect(rawConfig).not.toContain(handle.pushKey);
    });
  });

  describe("job test", () => {
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "FirstName", type: "Text", isKey: false },
    ];

    async function addHappyJob() {
      introspectCatalogMock.mockResolvedValue(
        sourceCatalog(
          sourceTable("dbo.Sales", [
            { name: "Id", type: "number", nullable: false },
            { name: "FirstName", type: "text", nullable: true },
          ]),
        ),
      );
      const handle = server.createTable({ columns: targetColumns });
      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );
      return { handle, job: result.job! };
    }

    it("passes when the schema matches", async () => {
      const { job } = await addHappyJob();
      const result = await testJob(job.id, dir);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("fails when a mapped target column is removed", async () => {
      const { handle, job } = await addHappyJob();
      server.updateTableSchema(handle.tableId, { columns: [{ name: "Id", type: "Number", isKey: true }] });
      const result = await testJob(job.id, dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes('target column "FirstName" was removed'))).toBe(true);
    });

    it("fails when it is retyped", async () => {
      const { handle, job } = await addHappyJob();
      server.updateTableSchema(handle.tableId, {
        columns: [
          { name: "Id", type: "Number", isKey: true },
          { name: "FirstName", type: "Boolean", isKey: false },
        ],
      });
      const result = await testJob(job.id, dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes('target column "FirstName" was retyped'))).toBe(true);
    });

    it("fails when the key columns change", async () => {
      const { handle, job } = await addHappyJob();
      server.updateTableSchema(handle.tableId, { keyColumns: [] });
      const result = await testJob(job.id, dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("key columns have changed"))).toBe(true);
    });
  });

  describe("job list", () => {
    it("never includes the push key", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: [{ name: "Id", type: "Number", isKey: true }] });
      await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      const jobs = listJobs(dir);
      expect(jobs).toHaveLength(1);
      expect(JSON.stringify(jobs)).not.toContain(handle.pushKey);
    });
  });

  describe("job remove", () => {
    it("removes the job and its secret", async () => {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: [{ name: "Id", type: "Number", isKey: true }] });
      const added = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );

      expect(removeJob(added.job!.id, dir)).toBe(true);
      expect(listJobs(dir)).toHaveLength(0);

      const masterKey = loadOrCreateMasterKey(dir);
      const secrets = new LocalSecretStore(masterKey, dir);
      expect(secrets.get(added.job!.pushKeyRef)).toBeNull();
    });
  });

  describe("job update", () => {
    const targetColumns: SchemaColumn[] = [{ name: "Id", type: "Number", isKey: true }];

    async function addHappyJob() {
      introspectCatalogMock.mockResolvedValue(sourceCatalog(sourceTable("dbo.Sales", [{ name: "Id", type: "number", nullable: false }])));
      const handle = server.createTable({ columns: targetColumns });
      const result = await addJob(
        { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
        {},
        dir,
      );
      return { handle, job: result.job! };
    }

    it("--rekey replaces the secret", async () => {
      const { handle, job } = await addHappyJob();
      const rotatedKey = "rotated-push-key";
      // Re-registering the same table id adds the new key as a second valid
      // credential for it (the fake server's key->table map is additive),
      // simulating a Planometry-side key rotation without needing a new
      // fake-server capability beyond what's already public.
      server.createTable({ id: handle.tableId, columns: targetColumns, pushKey: rotatedKey });

      const result = await updateJob(job.id, { rekey: rotatedKey }, {}, dir);
      expect(result.ok).toBe(true);

      const masterKey = loadOrCreateMasterKey(dir);
      const secrets = new LocalSecretStore(masterKey, dir);
      expect(secrets.get(job.pushKeyRef)).toBeNull();
      expect(secrets.get<{ pushKey: string }>(result.job!.pushKeyRef)).toEqual({ pushKey: rotatedKey });
    });

    it("refuses an invalid mapping and leaves the job unchanged", async () => {
      const { job } = await addHappyJob();

      const result = await updateJob(job.id, { mapOverrides: [{ source: "DoesNotExist", target: "Id" }] }, {}, dir);
      expect(result.ok).toBe(false);

      const jobs = listJobs(dir);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual(job);
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "./router.js";
import type { LocalApiDeps } from "./deps.js";

const { connectMock, introspectCatalogMock, getColumnNativeTypesMock, queryMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  introspectCatalogMock: vi.fn(),
  getColumnNativeTypesMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", async () => {
  const actual = await vi.importActual<typeof import("@nia/extract/mssql")>("@nia/extract/mssql");
  return { ...actual, connect: connectMock, introspectCatalog: introspectCatalogMock, getColumnNativeTypes: getColumnNativeTypesMock };
});

const { addConnection } = await import("../core/connections.js");
const { Logger } = await import("../ops/logger.js");
const { buildTablesRoutes } = await import("./routes/tables.js");
const { NotFoundError } = await import("./errors.js");

const FAKE_CATALOG = {
  generatedAt: new Date().toISOString(),
  sourceTimeZone: "UTC",
  tables: [
    {
      name: "dbo.customers",
      kind: "table" as const,
      primaryKey: ["id"],
      excluded: [],
      columns: [
        { name: "id", type: "number" as const, nullable: false },
        { name: "name", type: "text" as const, nullable: true },
      ],
    },
  ],
};

describe("GET /connections/:id/tables/:table/preview", () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-tables-"));
    deps = { dir, agentVersion: "0.0.0-test", logger: new Logger(dir) };

    addConnection(
      { id: "conn-1", label: "Test", host: "sql.local", database: "db", user: "sa", password: "pw", sourceTimeZone: "UTC" },
      dir,
    );

    connectMock.mockReset().mockResolvedValue({ request: () => ({ query: queryMock }), close: vi.fn() });
    introspectCatalogMock.mockReset().mockResolvedValue(FAKE_CATALOG);
    getColumnNativeTypesMock.mockReset().mockResolvedValue(
      new Map([
        ["id", "int"],
        ["name", "nvarchar"],
      ]),
    );
    queryMock.mockReset().mockResolvedValue({ recordset: [] });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ctx(connectionId: string, table: string, limit: string): RouteContext {
    return { params: { id: connectionId, table }, query: new URLSearchParams({ limit }), body: undefined };
  }

  it("clamps an over-large requested limit to TOP (50) in the generated SQL", async () => {
    const route = buildTablesRoutes(deps).find((r) => r.path === "/connections/:id/tables/:table/preview")!;
    await route.handler!(ctx("conn-1", "dbo.customers", "9999"));

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0]![0] as string;
    expect(sql).toContain("TOP (50)");
    expect(sql).not.toContain("TOP (9999)");
  });

  it("maps an unknown table to a 404 NotFoundError, not a raw catalog error", async () => {
    const route = buildTablesRoutes(deps).find((r) => r.path === "/connections/:id/tables/:table/preview")!;
    await expect(route.handler!(ctx("conn-1", "dbo.not_a_real_table", "10"))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps an unknown connection id to a 404", async () => {
    const route = buildTablesRoutes(deps).find((r) => r.path === "/connections/:id/tables/:table/preview")!;
    await expect(route.handler!(ctx("nope", "dbo.customers", "10"))).rejects.toBeInstanceOf(NotFoundError);
  });
});

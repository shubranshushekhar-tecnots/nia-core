import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../router.js";
import type { LocalApiDeps } from "../deps.js";

const { connectMock, queryMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", async () => {
  const actual = await vi.importActual<typeof import("@nia/extract/mssql")>("@nia/extract/mssql");
  return { ...actual, connect: connectMock };
});

const { addConnection } = await import("../../core/connections.js");
const { Logger } = await import("../../ops/logger.js");
const { buildConnectionsRoutes } = await import("./connections.js");
const { BadRequestError } = await import("../errors.js");

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

describe("connections routes", () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-connections-"));
    deps = { dir, agentVersion: "0.0.0-test", logger: new Logger(dir) };

    queryMock.mockReset().mockResolvedValue({ recordset: [{ name: "db1" }, { name: "db2" }] });
    connectMock.mockReset().mockResolvedValue({ request: () => ({ query: queryMock }), close: vi.fn() });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("POST /databases/list lists databases for raw credentials sent in the body (not a URL)", async () => {
    const route = buildConnectionsRoutes(deps).find((r) => r.method === "POST" && r.path === "/databases/list")!;
    const result = (await route.handler!(
      ctx({ body: { host: "sql.local", user: "sa", password: "pw" } }),
    )) as { ok: boolean; databases: string[] };

    expect(result.ok).toBe(true);
    expect(result.databases).toEqual(["db1", "db2"]);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock.mock.calls[0]![0]).toMatchObject({ server: "sql.local", user: "sa", password: "pw" });
  });

  it("GET /databases without a connectionId is rejected -- raw credentials must never travel in a URL", async () => {
    const route = buildConnectionsRoutes(deps).find((r) => r.method === "GET" && r.path === "/databases")!;
    await expect(route.handler!(ctx({ query: new URLSearchParams() }))).rejects.toBeInstanceOf(BadRequestError);
    // Credentials passed as query params must not be accepted as a substitute for connectionId.
    await expect(
      route.handler!(ctx({ query: new URLSearchParams({ host: "sql.local", user: "sa", password: "pw" }) })),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("GET /databases?connectionId=<id> still works for a saved connection", async () => {
    addConnection(
      { id: "conn-1", label: "Test", host: "sql.local", database: "db", user: "sa", password: "pw", sourceTimeZone: "UTC" },
      dir,
    );

    const route = buildConnectionsRoutes(deps).find((r) => r.method === "GET" && r.path === "/databases")!;
    const result = (await route.handler!(ctx({ query: new URLSearchParams({ connectionId: "conn-1" }) }))) as {
      ok: boolean;
      databases: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.databases).toEqual(["db1", "db2"]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Logger } from "../ops/logger.js";
import { createLocalApiServer, type LocalApiServerHandle } from "./server.js";
import type { RouteDefinition } from "./router.js";
import { buildConnectionsRoutes } from "./routes/connections.js";
import { buildTablesRoutes } from "./routes/tables.js";

/**
 * Full round trip through the real HTTP server (auth, rate limiting,
 * JSON parsing — nothing mocked) against the real Docker SQL Server
 * harness. Excluded from `pnpm test` (vitest.config.ts); run explicitly
 * with `pnpm test:integration` after `pnpm manual:sql:up`.
 */

const HOST = process.env.NIA_EXTRACT_MSSQL_HOST ?? "localhost";
const PORT = Number(process.env.NIA_EXTRACT_MSSQL_PORT ?? "14330");
const SA_USER = process.env.NIA_EXTRACT_MSSQL_USER ?? "sa";
const SA_PASSWORD = process.env.NIA_EXTRACT_MSSQL_PASSWORD ?? "N!aExtractTest_2026";
const DATABASE = process.env.NIA_EXTRACT_MSSQL_DATABASE ?? "nia_extract_test";

const API_TOKEN = "integration-test-token";

describe("local API server against a real SQL Server", () => {
  let dir: string;
  let handle: LocalApiServerHandle;
  let baseUrl: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-localapi-itest-"));
    dirs.push(dir);

    const deps = { dir, agentVersion: "0.0.0-test", logger: new Logger(dir) };
    const routes: RouteDefinition[] = [...buildConnectionsRoutes(deps), ...buildTablesRoutes(deps)];
    const created = await createLocalApiServer({ dir, apiToken: API_TOKEN, routes, logger: deps.logger });
    if (!created) throw new Error("local API server failed to bind for the integration test");
    handle = created;
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.close();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  afterEach(async () => {
    // Nothing per-test to clean up beyond the one connection added below (overwritten each run by its fixed id).
  });

  function authed(body?: unknown) {
    return {
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  it("tests a login, saves a connection, lists tables, and previews a table — all over real HTTP", async () => {
    const testRes = await request(`${baseUrl}/connections/test`, {
      method: "POST",
      ...authed({ host: HOST, port: PORT, user: SA_USER, password: SA_PASSWORD }),
    });
    expect(testRes.statusCode).toBe(200);
    const testBody = (await testRes.body.json()) as { ok: boolean; databases: string[] };
    expect(testBody.ok).toBe(true);
    expect(testBody.databases).toContain(DATABASE);

    const addRes = await request(`${baseUrl}/connections`, {
      method: "POST",
      ...authed({
        id: "itest-conn",
        label: "Integration test",
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: SA_USER,
        password: SA_PASSWORD,
        sourceTimeZone: "UTC",
        encrypt: false,
      }),
    });
    expect(addRes.statusCode).toBe(200);

    const tablesRes = await request(`${baseUrl}/connections/itest-conn/tables`, { headers: authed().headers });
    expect(tablesRes.statusCode).toBe(200);
    const tablesBody = (await tablesRes.body.json()) as { tables: { schema: string; table: string }[] };
    expect(tablesBody.tables.some((t) => t.schema === "dbo" && t.table === "widgets")).toBe(true);

    const previewRes = await request(`${baseUrl}/connections/itest-conn/tables/dbo.widgets/preview?limit=2`, { headers: authed().headers });
    expect(previewRes.statusCode).toBe(200);
    const previewBody = (await previewRes.body.json()) as { columns: unknown[]; rows: Record<string, unknown>[] };
    expect(previewBody.rows.length).toBeGreaterThan(0);
    expect(previewBody.rows.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(previewBody)).not.toContain(SA_PASSWORD);
  });

  it("rejects an unauthenticated request even against the real server", async () => {
    const res = await request(`${baseUrl}/connections`);
    expect(res.statusCode).toBe(401);
  });
});

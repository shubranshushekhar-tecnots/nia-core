#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FakePlanometryServer, type FakeTableDefinition, type InjectedFault } from "./fakePlanometryServer.js";

/**
 * Foreground fake Planometry v4 push server for manual end-to-end testing
 * (docs/manual-testing/agent.md) — wraps the test-only `FakePlanometryServer`
 * on a fixed, env-overridable port, plus a second tiny control HTTP server
 * exposing JSON endpoints a human (or `planometryCtl.ts`) can hit to create
 * a table and inject faults, without writing a test file.
 *
 * Not used by any automated test; `apps/agent/package.json`'s
 * `manual:planometry` script is this file's only caller.
 */

const FAKE_PLANOMETRY_PORT = Number(process.env.NIA_AGENT_FAKE_PLANOMETRY_PORT ?? 4455);
const CONTROL_PORT = Number(process.env.NIA_AGENT_FAKE_CONTROL_PORT ?? 4456);

async function main(): Promise<void> {
  const fake = await FakePlanometryServer.start({ port: FAKE_PLANOMETRY_PORT });
  const control = createControlServer(fake);
  await new Promise<void>((resolve) => control.listen(CONTROL_PORT, "127.0.0.1", resolve));

  console.log(`[fake-planometry] push API listening at ${fake.baseUrl}`);
  console.log(`[fake-planometry] control API listening at http://127.0.0.1:${CONTROL_PORT}`);
  console.log(`[fake-planometry] use "pnpm --filter @nia/agent run manual:planometry:ctl <subcommand>" to drive it`);

  const shutdown = async () => {
    console.log("\n[fake-planometry] shutting down...");
    await Promise.all([fake.close(), new Promise<void>((resolve) => control.close(() => resolve()))]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createControlServer(fake: FakePlanometryServer): Server {
  return createServer((req, res) => {
    handleControl(fake, req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleControl(fake: FakePlanometryServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/create-table") {
    const body = await readJsonBody<FakeTableDefinition>(req);
    const table = fake.createTable(body);
    console.log(`[fake-planometry] created table ${table.tableId} at ${table.tableUrl}`);
    sendJson(res, 200, table);
    return;
  }

  if (req.method === "POST" && url.pathname === "/inject-fault") {
    const body = await readJsonBody<{ tableId: string; fault: InjectedFault; times?: number }>(req);
    fake.injectFault(body.tableId, body.fault, body.times ?? 1);
    console.log(`[fake-planometry] fault armed: table=${body.tableId} fault=${JSON.stringify(body.fault)} times=${body.times ?? 1}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/rows") {
    const tableId = url.searchParams.get("tableId") ?? "";
    sendJson(res, 200, { rows: fake.getRows(tableId) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/open-load") {
    const tableId = url.searchParams.get("tableId") ?? "";
    sendJson(res, 200, { openLoad: fake.getOpenLoad(tableId) ?? null });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

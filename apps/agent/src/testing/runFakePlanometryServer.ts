#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FakePlanometryServer } from "./fakePlanometryServer.js";
import type { ExtractRequest } from "@nia/extract";

/**
 * Foreground fake Planometry server for manual end-to-end testing
 * (docs/manual-testing/agent.md) — wraps the test-only `FakePlanometryServer`
 * on a fixed, env-overridable port with verbose request logging, plus a
 * second tiny control HTTP server exposing JSON endpoints a human (or
 * `planometryCtl.ts`) can hit to issue an agent key, queue syncs, request a
 * catalog refresh, and inject faults — all without writing a test file.
 *
 * Not used by any automated test; `apps/agent/package.json`'s
 * `manual:planometry` script is this file's only caller.
 */

const FAKE_PLANOMETRY_PORT = Number(process.env.NIA_AGENT_FAKE_PLANOMETRY_PORT ?? 4455);
const CONTROL_PORT = Number(process.env.NIA_AGENT_FAKE_CONTROL_PORT ?? 4456);

async function main(): Promise<void> {
  const fake = await FakePlanometryServer.start({ port: FAKE_PLANOMETRY_PORT, verbose: true });
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

  if (req.method === "POST" && url.pathname === "/issue-key") {
    const agentKey = randomUUID();
    fake.requireAgentKey(agentKey);
    console.log(`[fake-planometry] issued agent key: ${agentKey}`);
    sendJson(res, 200, { agentKey });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/queue" || url.pathname === "/refresh-catalog")) {
    const body = await readJsonBody<{
      connectionId: string;
      runId: string;
      table: string;
      columns?: string[];
      filter?: unknown[];
      catalogRequested?: boolean;
    }>(req);
    const request: ExtractRequest = { table: body.table, columns: body.columns ?? [], filter: (body.filter as ExtractRequest["filter"]) ?? [] };
    const catalogRequested = url.pathname === "/refresh-catalog" ? true : (body.catalogRequested ?? false);
    fake.enqueueWork(body.connectionId, { runId: body.runId, request, catalogRequested });
    console.log(`[fake-planometry] queued run=${body.runId} connection=${body.connectionId} table=${body.table}${catalogRequested ? " (catalog refresh requested)" : ""}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/fault/drop") {
    const body = await readJsonBody<{ runId: string; seq: number }>(req);
    const existing = fake.getRunFaults(body.runId) ?? {};
    const dropOnFirstAttempt = new Set(existing.dropOnFirstAttempt ?? []);
    dropOnFirstAttempt.add(body.seq);
    fake.setRunFaults(body.runId, { ...existing, dropOnFirstAttempt });
    console.log(`[fake-planometry] fault armed: run=${body.runId} seq=${body.seq} will be dropped on first attempt`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/fault/409") {
    const body = await readJsonBody<{ runId: string; seq: number }>(req);
    const existing = fake.getRunFaults(body.runId) ?? {};
    const force409 = new Set(existing.force409 ?? []);
    force409.add(body.seq);
    fake.setRunFaults(body.runId, { ...existing, force409 });
    console.log(`[fake-planometry] fault armed: run=${body.runId} seq=${body.seq} will always get 409`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/slow") {
    const body = await readJsonBody<{ pollAfterSeconds: number }>(req);
    fake.setPollAfterSeconds(body.pollAfterSeconds);
    console.log(`[fake-planometry] empty polls now wait ${body.pollAfterSeconds}s before the agent re-polls`);
    sendJson(res, 200, { ok: true });
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

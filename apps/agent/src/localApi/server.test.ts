import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../ops/logger.js";
import { createLocalApiServer, type LocalApiServerHandle } from "./server.js";
import type { RouteDefinition } from "./router.js";

const PING_ROUTES: RouteDefinition[] = [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }];

// Every request() call below passes `reset: true` so undici never pools a
// keep-alive socket across test boundaries. Without it, a socket opened by
// one test's request stays cached in undici's connection pool keyed by
// origin (http://127.0.0.1:<port>) -- since createLocalApiServer() always
// tries the same default port first and tests close + immediately rebind
// on it, a later test can end up sharing that origin with an earlier one.
// `close()`'s `server.closeAllConnections()` destroys that socket server-side
// as soon as the owning test's server shuts down, but undici's pool doesn't
// learn about it synchronously -- a subsequent request reusing the
// now-dead socket fails with a flaky client-side ECONNRESET.
describe("local API server", () => {
  let dir: string;
  let handle: LocalApiServerHandle | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-"));
  });

  afterEach(async () => {
    await handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("binds to 127.0.0.1 only and writes the port file", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    expect(handle).toBeDefined();
    expect(handle!.port).toBeGreaterThan(0);

    const portFile = JSON.parse(fs.readFileSync(path.join(dir, "local-api", "port.json"), "utf8")) as { port: number };
    expect(portFile.port).toBe(handle!.port);
  });

  it("rejects a request with no Authorization header", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const res = await request(`http://127.0.0.1:${handle!.port}/ping`, { reset: true });
    expect(res.statusCode).toBe(401);
    const body = (await res.body.json()) as { kind: string };
    expect(body.kind).toBe("unauthorized");
  });

  it("rejects a request with the wrong token", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const res = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { authorization: "Bearer wrong-token" },
      reset: true,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a request with the correct bearer token", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const res = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { authorization: "Bearer test-token" },
      reset: true,
    });
    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({ ok: true });
  });

  it("returns 404 for an unknown path and 405 for a known path with the wrong method", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const headers = { authorization: "Bearer test-token" };

    const notFound = await request(`http://127.0.0.1:${handle!.port}/nope`, { headers, reset: true });
    expect(notFound.statusCode).toBe(404);

    const wrongMethod = await request(`http://127.0.0.1:${handle!.port}/ping`, { method: "POST", headers, reset: true });
    expect(wrongMethod.statusCode).toBe(405);
  });

  it("falls back to the next port when the default is already taken", async () => {
    const first = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const second = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    expect(second!.port).toBe(first!.port + 1);
    await first!.close();
    await second!.close();
    handle = undefined;
  });

  // DNS-rebinding defense: a page that lures a victim's browser into
  // resolving some attacker-controlled hostname to 127.0.0.1 must not be
  // able to reach this server just because the browser dereferenced that
  // hostname to the right IP -- the Host header itself must also name
  // 127.0.0.1/localhost on the actual bound port.
  it("rejects a request whose Host header doesn't name 127.0.0.1/localhost on the bound port with 403", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const headers = { authorization: "Bearer test-token" };

    const rebound = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { ...headers, host: "evil.example.com" },
      reset: true,
    });
    expect(rebound.statusCode).toBe(403);
    const body = (await rebound.body.json()) as { kind: string };
    expect(body.kind).toBe("forbidden");

    const wrongPort = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { ...headers, host: `127.0.0.1:${handle!.port + 1}` },
      reset: true,
    });
    expect(wrongPort.statusCode).toBe(403);
  });

  it("accepts a request whose Host header is 127.0.0.1 or localhost on the actual bound port", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const headers = { authorization: "Bearer test-token" };

    const viaIp = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { ...headers, host: `127.0.0.1:${handle!.port}` },
      reset: true,
    });
    expect(viaIp.statusCode).toBe(200);

    const viaLocalhost = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { ...headers, host: `localhost:${handle!.port}` },
      reset: true,
    });
    expect(viaLocalhost.statusCode).toBe(200);
  });

  // Omission, not an explicit "deny all" header, is the defense (see
  // router.ts's sendJson) -- same-origin policy already stops another
  // origin's page from reading the response, and we never want to opt
  // back into cross-origin reads by setting Access-Control-Allow-Origin.
  it("never sends CORS headers", async () => {
    handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: PING_ROUTES, logger: new Logger(dir) });
    const res = await request(`http://127.0.0.1:${handle!.port}/ping`, {
      headers: { authorization: "Bearer test-token" },
      reset: true,
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  // Regression guard: `GET /logs/stream?token=...` is the one route that
  // must carry the bearer token in a URL at all (EventSource can't set
  // headers) -- nothing in the request pipeline may ever write that URL,
  // or the token itself, to the agent's own log file.
  it("never logs the bearer token, even when a request carries it in the URL", async () => {
    const queryTokenRoutes: RouteDefinition[] = [
      { method: "GET", path: "/ping", handler: () => ({ ok: true }), allowQueryToken: true },
    ];
    handle = await createLocalApiServer({ dir, apiToken: "super-secret-token", routes: queryTokenRoutes, logger: new Logger(dir) });

    await request(`http://127.0.0.1:${handle!.port}/ping?token=super-secret-token`, { reset: true });
    await request(`http://127.0.0.1:${handle!.port}/ping`, { headers: { authorization: "Bearer super-secret-token" }, reset: true });

    const logPath = path.join(dir, "agent.log");
    const logContents = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    expect(logContents).not.toContain("super-secret-token");
  });
});

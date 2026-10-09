import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../ops/logger.js";
import { createLocalApiServer, type LocalApiServerHandle } from "./server.js";
import type { RouteDefinition, StaticHandler } from "./router.js";
import { createSession } from "./sessionStore.js";

const PING_ROUTES: RouteDefinition[] = [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }];

/** Pulls just the `nia_ui_session=<id>` pair out of a raw `Set-Cookie` header, ignoring the HttpOnly/SameSite/Path/Max-Age attributes. */
function sessionCookieFrom(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("no Set-Cookie header");
  return header.split(";")[0]!;
}

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

  // Phase 2 (M1): `auth: "session"` routes -- the browser UI's path, never
  // carrying the real bearer token.
  describe("session auth (auth: 'session' routes)", () => {
    const SESSION_ROUTES: RouteDefinition[] = [
      { method: "GET", path: "/ui/api/ping", auth: "session", handler: () => ({ ok: true }) },
      { method: "POST", path: "/ui/api/ping", auth: "session", handler: () => ({ ok: true }) },
      { method: "DELETE", path: "/ui/api/ping", auth: "session", handler: () => ({ ok: true }) },
    ];

    it("rejects a GET with no session cookie", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, { reset: true });
      expect(res.statusCode).toBe(401);
      const body = (await res.body.json()) as { kind: string };
      expect(body.kind).toBe("sessionExpired");
    });

    it("rejects a GET with an unknown/garbage session cookie", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        headers: { cookie: "nia_ui_session=not-a-real-session" },
        reset: true,
      });
      expect(res.statusCode).toBe(401);
    });

    it("accepts a GET with a valid session cookie, with no bearer token anywhere", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        headers: { cookie: `nia_ui_session=${sessionId}` },
        reset: true,
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects a POST with a valid session cookie but no X-Nia-UI CSRF header", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        method: "POST",
        headers: { cookie: `nia_ui_session=${sessionId}` },
        reset: true,
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects a DELETE with a valid session cookie but no X-Nia-UI CSRF header", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        method: "DELETE",
        headers: { cookie: `nia_ui_session=${sessionId}` },
        reset: true,
      });
      expect(res.statusCode).toBe(403);
    });

    it("accepts a POST with a valid session cookie AND the X-Nia-UI CSRF header", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        method: "POST",
        headers: { cookie: `nia_ui_session=${sessionId}`, "x-nia-ui": "1" },
        reset: true,
      });
      expect(res.statusCode).toBe(200);
    });

    it("still enforces the Host-header DNS-rebinding check on session routes", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: SESSION_ROUTES, logger: new Logger(dir) });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        headers: { cookie: `nia_ui_session=${sessionId}`, host: "evil.example.com" },
        reset: true,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // Phase 2 (M1): the full OTC -> session cookie handoff via the real
  // /otc + /ui/session routes, as `agentLoop.ts` wires them.
  describe("OTC -> session handoff", () => {
    it("mints a code with /otc (bearer), trades it for a session cookie with /ui/session, then uses that cookie on a session route -- the real token appears nowhere in the /ui/session exchange", async () => {
      const { buildOtcRoutes, buildUiSessionRoutes } = await import("./routes/uiAuth.js");
      const { mirrorRoutesForUi } = await import("./uiProxyRoutes.js");
      const pingRoute: RouteDefinition = { method: "GET", path: "/ping", handler: () => ({ ok: true }) };
      const routes: RouteDefinition[] = [pingRoute, ...buildOtcRoutes(), ...buildUiSessionRoutes(), ...mirrorRoutesForUi([pingRoute])];
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes, logger: new Logger(dir) });

      const otcRes = await request(`http://127.0.0.1:${handle!.port}/otc`, {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        reset: true,
      });
      expect(otcRes.statusCode).toBe(200);
      const { otc } = (await otcRes.body.json()) as { otc: string };
      expect(otc).not.toContain("test-token");

      const sessionRes = await request(`http://127.0.0.1:${handle!.port}/ui/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otc }),
        reset: true,
      });
      expect(sessionRes.statusCode).toBe(200);
      const sessionBody = await sessionRes.body.text();
      expect(sessionBody).not.toContain("test-token");
      const cookie = sessionCookieFrom(sessionRes.headers["set-cookie"]);

      // The code is single-use -- trading it again must fail.
      const replay = await request(`http://127.0.0.1:${handle!.port}/ui/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otc }),
        reset: true,
      });
      expect(replay.statusCode).toBe(400);

      const mirroredRes = await request(`http://127.0.0.1:${handle!.port}/ui/api/ping`, {
        headers: { cookie },
        reset: true,
      });
      expect(mirroredRes.statusCode).toBe(200);
    });
  });

  // Phase 2 (M1): `staticHandler` -- `/` is gated on session, every other
  // static path is not.
  describe("static handler", () => {
    const INDEX_HTML = Buffer.from("<html>app shell</html>", "utf8");
    const APP_JS = Buffer.from("console.log('hi')", "utf8");
    const staticHandler: StaticHandler = async (pathname, hasValidSession) => {
      if (pathname === "/") return hasValidSession ? { data: INDEX_HTML, contentType: "text/html" } : undefined;
      if (pathname === "/app.js") return { data: APP_JS, contentType: "text/javascript" };
      return undefined;
    };

    it("serves a plain fallback (not the app shell) at / with no session", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: [], logger: new Logger(dir), staticHandler });
      const res = await request(`http://127.0.0.1:${handle!.port}/`, { reset: true });
      // Our test staticHandler returns undefined for `/` without a session,
      // so the router itself falls through to a plain 404 -- the real
      // uiStaticHandler.ts instead returns an inline "open from the Start
      // menu" page (see uiStaticHandler.test.ts).
      expect(res.statusCode).toBe(404);
    });

    it("serves the app shell at / with a valid session", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: [], logger: new Logger(dir), staticHandler });
      const sessionId = createSession();
      const res = await request(`http://127.0.0.1:${handle!.port}/`, { headers: { cookie: `nia_ui_session=${sessionId}` }, reset: true });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe("<html>app shell</html>");
    });

    it("serves a non-sensitive static path regardless of session", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: [], logger: new Logger(dir), staticHandler });
      const res = await request(`http://127.0.0.1:${handle!.port}/app.js`, { reset: true });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe("console.log('hi')");
    });

    it("never consults the static handler for a non-GET request", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: [], logger: new Logger(dir), staticHandler });
      const res = await request(`http://127.0.0.1:${handle!.port}/app.js`, { method: "POST", reset: true });
      expect(res.statusCode).toBe(404);
    });

    it("serves the app shell at /?otc=... even with no session yet -- the app shell's own JS is what trades the code for a session", async () => {
      handle = await createLocalApiServer({ dir, apiToken: "test-token", routes: [], logger: new Logger(dir), staticHandler });
      const res = await request(`http://127.0.0.1:${handle!.port}/?otc=some-code`, { reset: true });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe("<html>app shell</html>");
    });
  });
});

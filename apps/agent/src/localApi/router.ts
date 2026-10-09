import type { IncomingMessage, ServerResponse } from "node:http";
import { tokensMatch } from "./authToken.js";
import { ApiError, BadRequestError, ForbiddenError, RateLimitedError, SessionExpiredError, UnauthorizedError } from "./errors.js";
import type { RateLimiter } from "./rateLimit.js";
import { touchSession } from "./sessionStore.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Lets a handler set response headers (e.g. `Set-Cookie`) before the router writes the JSON envelope -- see routes/uiAuth.ts. */
  res: ServerResponse;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

export interface RouteDefinition {
  method: HttpMethod;
  /** e.g. "/connections/:id/tables/:table/preview" — `:name` segments are captured into `ctx.params`. */
  path: string;
  /** Ignored when `sse` is set. */
  handler?: RouteHandler;
  rateLimiter?: RateLimiter;
  /** Set only for the one streaming route (`GET /logs/stream`) — writes directly to `res`, bypasses the `{kind,message}`/JSON envelope entirely. Auth/rate-limit still run first. */
  sse?: (ctx: RouteContext, res: ServerResponse) => void;
  /** EventSource can't set an `Authorization` header — this route may authenticate via `?token=` instead. Every other route requires the header. Ignored for `auth: "session"` routes (the browser sends the session cookie automatically, same-origin). */
  allowQueryToken?: boolean;
  /**
   * `"bearer"` (default, unchanged): `Authorization: Bearer <token>` (or
   * `?token=` if `allowQueryToken`). `"session"`: the `nia_ui_session`
   * cookie, refreshed via `touchSession` on every request (12h sliding
   * inactivity window) -- used by `/ui/api/*` (uiProxyRoutes.ts). Mutating
   * (`POST`/`DELETE`) session routes additionally require the
   * `X-Nia-UI: 1` header as CSRF defense (a cross-origin page's form/fetch
   * can't set a custom header without triggering a CORS preflight, which
   * this server will never answer since it sends no CORS headers at all).
   * `"none"`: no auth at all, only `/ui/session` itself (minting the
   * session in the first place) and static assets.
   */
  auth?: "bearer" | "session" | "none";
}

/** Lazily-parsed, never logged (it's a credential): finds one cookie by name out of the raw `Cookie` header. */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]!;
    const actual = pathParts[i]!;
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(actual);
    } else if (part !== actual) {
      return null;
    }
  }
  return params;
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  // Deliberately no Access-Control-Allow-Origin (or any other CORS header)
  // anywhere in this file -- the browser's own same-origin policy is the
  // defense; a page on another origin can't read this response even if it
  // can trigger the request, and we never want to opt back into that.
  res.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * DNS-rebinding defense: a page that lures a victim's browser into
 * resolving some attacker-controlled hostname to 127.0.0.1 could otherwise
 * make same-origin-policy-exempt requests straight at this server. Reject
 * anything whose `Host` header isn't literally `127.0.0.1:<port>` or
 * `localhost:<port>`, where `<port>` must match the port this connection
 * actually arrived on (`req.socket.localPort` — always the real bound
 * port, so this never needs the port threaded into `createRouter`
 * separately, and can never drift from whatever `server.ts`'s fallback
 * range actually picked).
 */
function isAllowedHost(req: IncomingMessage): boolean {
  const header = req.headers.host;
  if (!header) return false;
  const match = /^(.+):(\d+)$/.exec(header);
  if (!match) return false; // no explicit port -- reject rather than guess
  const [, hostname, portStr] = match;
  const normalizedHost = hostname!.toLowerCase();
  if (normalizedHost !== "127.0.0.1" && normalizedHost !== "localhost") return false;
  return Number(portStr) === req.socket.localPort;
}

/**
 * Tiny method+path matcher — every route runs through, in order: Host
 * header check (DNS rebinding defense, 403 on mismatch) → auth (bearer
 * token, timing-safe compare) → rate limit (if the route has one) → JSON
 * body parse (GET/DELETE never read a body) → handler → `{kind,message}`
 * error envelope on throw (errors.ts's `ApiError` subclasses map to their
 * own status code; anything else becomes a generic 500
 * `{kind:"internal",...}` so a raw stack/driver message — which might
 * carry a password — never reaches the response body).
 *
 * This function (and everything it calls) must never log `req.url` or
 * any query string -- `GET /logs/stream?token=...` is the one route that
 * carries the bearer token in the URL (EventSource can't set headers), so
 * logging the raw URL anywhere would put the token in the agent's own
 * log file. If a path is ever logged, log `url.pathname` only.
 */
export interface StaticAsset {
  data: Buffer;
  contentType: string;
}

/**
 * Only consulted for a GET that matched no route -- `/` plus every UI
 * static path (JS/CSS/fonts/favicon/...). The second parameter lets `/`
 * decide between the real app shell and a plain "open from the Start
 * menu" fallback page; everything else is served regardless, since it's
 * not sensitive. Despite the name, `createRouter` passes `true` here not
 * just for an already-valid session but also for a first-ever visit
 * carrying `?otc=...` -- the app shell's own JS is what actually trades
 * that code for the session cookie via `POST /ui/session`, so it must
 * be allowed to load before a session exists.
 */
export type StaticHandler = (pathname: string, hasValidSession: boolean) => Promise<StaticAsset | undefined>;

function hasValidUiSession(req: IncomingMessage): boolean {
  const cookie = readCookie(req, "nia_ui_session");
  return cookie ? touchSession(cookie) : false;
}

/**
 * Tiny method+path matcher — every route runs through, in order: Host
 * header check (DNS rebinding defense, 403 on mismatch) → auth (bearer
 * token by default, timing-safe compare; or session cookie + CSRF header
 * for `auth: "session"` routes; or none for `auth: "none"`) → rate limit
 * (if the route has one) → JSON body parse (GET/DELETE never read a
 * body) → handler → `{kind,message}` error envelope on throw (errors.ts's
 * `ApiError` subclasses map to their own status code; anything else
 * becomes a generic 500 `{kind:"internal",...}` so a raw stack/driver
 * message — which might carry a password — never reaches the response
 * body). A GET matching no route falls through to `staticHandler`, if
 * given, before a 404.
 *
 * This function (and everything it calls) must never log `req.url` or
 * any query string -- `GET /logs/stream?token=...` is the one route that
 * carries the bearer token in the URL (EventSource can't set headers), so
 * logging the raw URL anywhere would put the token in the agent's own
 * log file. If a path is ever logged, log `url.pathname` only.
 */
export function createRouter(routes: RouteDefinition[], apiToken: string, staticHandler?: StaticHandler) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req)) {
      const err = new ForbiddenError();
      sendJson(res, err.statusCode, err.toBody());
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();

    let matchedPath = false;
    for (const route of routes) {
      const params = matchPath(route.path, url.pathname);
      if (!params) continue;
      matchedPath = true;
      if (route.method !== method) continue;

      try {
        const auth = route.auth ?? "bearer";
        if (auth === "bearer") {
          const headerToken = extractBearerToken(req);
          const token = route.allowQueryToken ? (headerToken ?? url.searchParams.get("token") ?? undefined) : headerToken;
          if (!token || !tokensMatch(token, apiToken)) throw new UnauthorizedError();
        } else if (auth === "session") {
          if (!hasValidUiSession(req)) throw new SessionExpiredError();
          if ((method === "POST" || method === "DELETE") && req.headers["x-nia-ui"] !== "1") throw new ForbiddenError();
        }

        if (route.rateLimiter && !route.rateLimiter.tryHit()) throw new RateLimitedError();

        const ctx: RouteContext = {
          params,
          query: url.searchParams,
          body: method === "GET" || method === "DELETE" ? undefined : await readJsonBody(req),
          res,
        };

        if (route.sse) {
          route.sse(ctx, res);
          return;
        }

        const result = await route.handler!(ctx);
        sendJson(res, 200, result ?? {});
      } catch (err) {
        if (err instanceof ApiError) {
          sendJson(res, err.statusCode, err.toBody());
          return;
        }
        sendJson(res, 500, { kind: "internal", message: "internal error" });
      }
      return;
    }

    if (!matchedPath && method === "GET" && staticHandler) {
      // A first-ever `/?otc=...` visit (no session cookie yet) must still
      // see the real app shell -- only its own JS can trade that code for
      // a session via POST /ui/session. `url.searchParams.has` alone is
      // enough; the OTC itself is still single-use/60s-TTL/bearer-minted,
      // so a bare `?otc=` with no real code gets nothing from `/ui/session`.
      const asset = await staticHandler(url.pathname, hasValidUiSession(req) || url.searchParams.has("otc"));
      if (asset) {
        res.writeHead(200, { "content-type": asset.contentType, "content-length": asset.data.length });
        res.end(asset.data);
        return;
      }
    }

    sendJson(res, matchedPath ? 405 : 404, { kind: matchedPath ? "methodNotAllowed" : "notFound", message: matchedPath ? "method not allowed" : "not found" });
  };
}

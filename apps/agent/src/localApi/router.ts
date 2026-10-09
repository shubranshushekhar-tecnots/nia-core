import type { IncomingMessage, ServerResponse } from "node:http";
import { tokensMatch } from "./authToken.js";
import { ApiError, BadRequestError, ForbiddenError, RateLimitedError, UnauthorizedError } from "./errors.js";
import type { RateLimiter } from "./rateLimit.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
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
  /** EventSource can't set an `Authorization` header — this route may authenticate via `?token=` instead. Every other route requires the header. */
  allowQueryToken?: boolean;
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
export function createRouter(routes: RouteDefinition[], apiToken: string) {
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
        const headerToken = extractBearerToken(req);
        const token = route.allowQueryToken ? (headerToken ?? url.searchParams.get("token") ?? undefined) : headerToken;
        if (!token || !tokensMatch(token, apiToken)) throw new UnauthorizedError();

        if (route.rateLimiter && !route.rateLimiter.tryHit()) throw new RateLimitedError();

        const ctx: RouteContext = {
          params,
          query: url.searchParams,
          body: method === "GET" || method === "DELETE" ? undefined : await readJsonBody(req),
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

    sendJson(res, matchedPath ? 405 : 404, { kind: matchedPath ? "methodNotAllowed" : "notFound", message: matchedPath ? "method not allowed" : "not found" });
  };
}

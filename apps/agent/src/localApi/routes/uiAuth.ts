import { OtcInvalidError, BadRequestError } from "../errors.js";
import { mintOtc, consumeOtc } from "../otcStore.js";
import { createSession, SESSION_TTL_MS } from "../sessionStore.js";
import type { RouteDefinition } from "../router.js";

/**
 * `POST /otc`: bearer-authed (default `auth`, unchanged) -- only a caller
 * that already holds the real token (`nia-agent open`, reading it straight
 * off disk) can mint a one-time code. The browser never sees this route or
 * the token; it only ever sees the minted code, once, in its own address
 * bar, for up to 60s.
 */
export function buildOtcRoutes(): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/otc",
      handler: () => ({ otc: mintOtc() }),
    },
  ];
}

/**
 * `POST /ui/session`: `auth: "none"` (still subject to the Host-header
 * DNS-rebinding check, like every route) -- trades a one-time code for a
 * session cookie. The real bearer token is never read or returned here;
 * `Set-Cookie`'s `Max-Age=86400` (24h) is just an outer ceiling -- the
 * real enforcement is server-side, `sessionStore.ts`'s 12h sliding
 * inactivity window (`touchSession`, checked on every `auth: "session"`
 * request).
 */
export function buildUiSessionRoutes(): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/ui/session",
      auth: "none",
      handler: (ctx) => {
        const body = ctx.body as { otc?: unknown } | undefined;
        if (!body || typeof body.otc !== "string" || body.otc.length === 0) {
          throw new BadRequestError("missing otc");
        }
        if (!consumeOtc(body.otc)) throw new OtcInvalidError();

        const sessionId = createSession();
        const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000) * 2; // 24h ceiling, see doc comment above
        ctx.res.setHeader("Set-Cookie", `nia_ui_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`);
        return { ok: true };
      },
    },
  ];
}

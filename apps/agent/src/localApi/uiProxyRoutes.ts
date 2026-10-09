import type { RouteDefinition } from "./router.js";

/**
 * Mirrors a set of bearer-authed routes under `/ui/api/*`, authenticated
 * by session cookie instead of the bearer token -- the browser UI drives
 * the exact same handlers (and shares the same `rateLimiter` instances,
 * intentionally: one budget, whichever caller hits it) without the real
 * token ever reaching browser JS. Not applied to `/otc` (bearer-only,
 * never mirrored -- the browser must never be able to mint its own
 * codes) or to the static/`/ui/session` routes (not bearer routes to
 * begin with).
 */
export function mirrorRoutesForUi(routes: RouteDefinition[]): RouteDefinition[] {
  return routes.map((route) => ({
    ...route,
    path: `/ui/api${route.path}`,
    auth: "session" as const,
  }));
}

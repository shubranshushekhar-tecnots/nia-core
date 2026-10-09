import { allowDestinationHost, listAllowedDestinationHosts, removeAllowedDestinationHost } from "../../destinations/allowedHosts.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

function requireHost(body: unknown): string {
  const host = (body as Record<string, unknown> | undefined)?.host;
  if (typeof host !== "string" || host.length === 0) throw new BadRequestError("host is required");
  return host;
}

/** `GET/POST/DELETE /destinations`: thin wrapper around `destinations/allowedHosts.ts`'s local allow-list -- generic across destination types, not HTTPS-specific. */
export function buildDestinationsRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/destinations",
      handler: () => ({ hosts: listAllowedDestinationHosts(deps.dir) }),
    },
    {
      method: "POST",
      path: "/destinations",
      handler: (ctx) => {
        const host = requireHost(ctx.body);
        allowDestinationHost(host, deps.dir);
        return { host };
      },
    },
    {
      method: "DELETE",
      path: "/destinations/:host",
      handler: (ctx) => {
        const removed = removeAllowedDestinationHost(decodeURIComponent(ctx.params.host!), deps.dir);
        if (!removed) throw new NotFoundError(`host ${JSON.stringify(ctx.params.host)} is not in the allow-list`);
        return { removed: true };
      },
    },
  ];
}

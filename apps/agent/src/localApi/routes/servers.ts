import { detectWindowsSqlInstances } from "../../core/sqlDiscovery.js";
import type { RouteDefinition } from "../router.js";

/** `GET /servers`: SQL Browser-discovered local instances — empty array off-Windows (same passthrough the CLI wizard uses). */
export function buildServersRoutes(): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/servers",
      handler: async () => ({ instances: await detectWindowsSqlInstances() }),
    },
  ];
}

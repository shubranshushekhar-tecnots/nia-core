import { loadConfig } from "../../config/store.js";
import { getStatus } from "../../ops/state.js";
import { readLinkState } from "../../ops/linkState.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

/** A check-in older than this is reported as offline, even without an explicit `revoked` flag. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** `GET /status`: paired?, platformUrl/agentId, online (derived from check-in recency), last check-in, version, job summary. */
export function buildStatusRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/status",
      handler: () => {
        const config = loadConfig(deps.dir);
        const report = getStatus(deps.dir);
        const base = { agentVersion: deps.agentVersion, startedAt: report.startedAt, uptimeSeconds: report.uptimeSeconds, jobs: report.jobs };

        if (!config.link) return { paired: false, ...base };

        const linkState = readLinkState(deps.dir);
        const online = !linkState.revoked && linkState.lastCheckInAt !== undefined && Date.now() - Date.parse(linkState.lastCheckInAt) < ONLINE_WINDOW_MS;

        return {
          paired: true,
          platformUrl: config.link.platformUrl,
          agentId: config.link.agentId,
          online,
          lastCheckInAt: linkState.lastCheckInAt,
          revoked: linkState.revoked ?? false,
          ...base,
        };
      },
    },
  ];
}

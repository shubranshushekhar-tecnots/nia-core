import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config/store.js";
import { defaultLogDir } from "../../config/paths.js";
import { listAllowedDestinationHosts } from "../../destinations/allowedHosts.js";
import { getStatus } from "../../ops/state.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

const LOG_TAIL_LINES = 100;

function tailLogLines(dir: string, count: number): string[] {
  const file = path.join(defaultLogDir(dir), "agent.log");
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(-count);
}

/**
 * `GET /diagnostics`: version, platform, status, and every non-secret
 * config field (connections -- `credentialRef` only, never the
 * credential itself; jobs -- `pushKeyRef` only; destinations allow-list;
 * `link` reduced to `platformUrl`/`agentId`, no `agentKeyRef`) plus a
 * log tail. The secret store (`secrets/store.ts`) is never opened here.
 */
export function buildDiagnosticsRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/diagnostics",
      handler: () => {
        const config = loadConfig(deps.dir);
        return {
          agentVersion: deps.agentVersion,
          platform: process.platform,
          status: getStatus(deps.dir),
          config: {
            connections: config.connections,
            jobs: config.jobs,
            destinations: listAllowedDestinationHosts(deps.dir),
            link: config.link ? { platformUrl: config.link.platformUrl, agentId: config.link.agentId } : undefined,
          },
          logs: tailLogLines(deps.dir, LOG_TAIL_LINES),
        };
      },
    },
  ];
}

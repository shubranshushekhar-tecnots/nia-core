import { isAutoUpdateEnabled, loadConfig, saveConfig, setAutoUpdateEnabled } from "../../config/store.js";
import { BadRequestError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

function parseEnabledInput(body: unknown): boolean {
  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).enabled !== "boolean") {
    throw new BadRequestError("enabled must be a boolean");
  }
  return (body as { enabled: boolean }).enabled;
}

/**
 * `POST /update/check`: lets the desktop app's "Check now" button trigger
 * one `UpdateChecker.tick()` immediately instead of waiting for its own
 * jittered timer. `updateChecker` is `undefined` whenever unpaired/no live
 * link (same "not paired" signal the other route builders use) — the
 * agent can't check for updates without a platform URL + agent key to
 * call `/agent-api/update` on.
 *
 * `GET`/`POST /update/settings`: the Settings screen's "Automatic
 * updates" toggle — reads/writes `agent.config.json`'s `autoUpdate.enabled`
 * directly (same read-live-config-every-time convention `UpdateChecker`
 * itself uses), independent of whether the agent is currently paired.
 */
export function buildUpdateRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/update/check",
      handler: async () => {
        const checker = deps.getUpdateChecker?.();
        if (!checker) return { triggered: false, reason: "not paired" };
        await checker.tick();
        return { triggered: true };
      },
    },
    {
      method: "GET",
      path: "/update/settings",
      handler: () => ({ enabled: isAutoUpdateEnabled(loadConfig(deps.dir)) }),
    },
    {
      method: "POST",
      path: "/update/settings",
      handler: (ctx) => {
        const enabled = parseEnabledInput(ctx.body);
        saveConfig(setAutoUpdateEnabled(loadConfig(deps.dir), enabled), deps.dir);
        return { enabled };
      },
    },
  ];
}

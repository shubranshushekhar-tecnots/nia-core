import type { ConnectorManifest } from "@nia/schemas";
import { HealthResponse } from "@nia/schemas";
import { env } from "../env.js";

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Deliberately duplicated from connectorClient.ts's own (unexported)
 * baseUrl() rather than imported — importing it would create a
 * connectorClient.ts <-> routeAwareness.ts circular module dependency
 * (connectorClient.ts calls warnIfRouteMissing at the top of its send*
 * functions). Same "duplicate a one-line host-resolution helper rather than
 * couple two modules" call as writeSignature.ts's independent worker/
 * connector-supabase copies.
 */
function baseUrl(manifest: ConnectorManifest): string {
  const host = env.CONNECTOR_DEV_HOST ?? manifest.service.host;
  return `http://${host}:${manifest.service.port}`;
}

/**
 * Lightweight route-skew guard (Phase 6 Block 2 follow-up). A connector
 * service's image can lag behind the manifest that describes it — e.g. an
 * older connector-mysql container that predates a new /write route. Rather
 * than let dispatch surface that as a raw, confusing 404 mid-job,
 * connectorClient.ts's send* functions call warnIfRouteMissing() first: it
 * probes the connector's /health (now carrying a `routes` array, see
 * @nia/schemas contract.ts's HealthResponse) and console.warns if the route
 * about to be dispatched to isn't advertised.
 *
 * Deliberately NOT a hard block — this is advisory only:
 *  - /health can be unreachable/slow for reasons unrelated to route support
 *    (cold start, transient network blip), and failing dispatch on a probe
 *    failure would be a worse outcome than just trying the real call.
 *  - The probe is fire-and-forget and never awaited by callers — it must
 *    never add latency to the real dispatch path.
 *  - Full version handshake (semver compat, capability negotiation) is
 *    deferred to Phase 9 hardening; this is a cheap stopgap for the
 *    specific "service image is stale" failure mode.
 *
 * Cached per connector id for the process lifetime — one /health probe per
 * connector per worker process, not one per dispatch call.
 */
const routeCache = new Map<string, Promise<Set<string> | null>>();

async function fetchRoutes(manifest: ConnectorManifest): Promise<Set<string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl(manifest)}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const parsed = HealthResponse.safeParse(await res.json());
    if (!parsed.success) return null;
    return new Set(parsed.data.routes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget: never await this from a dispatch call site. Logs a
 * console.warn if the connector's advertised routes are known and don't
 * include `route`; silently no-ops if the probe fails or hasn't resolved
 * yet (never blocks, never throws).
 */
export function warnIfRouteMissing(manifest: ConnectorManifest, route: string): void {
  let cached = routeCache.get(manifest.id);
  if (!cached) {
    cached = fetchRoutes(manifest);
    routeCache.set(manifest.id, cached);
  }
  cached
    .then((routes) => {
      if (routes && !routes.has(route)) {
        console.warn(
          `[routeAwareness] connector "${manifest.id}" does not advertise route "${route}" in its /health response — the service image may be stale. Dispatch will likely 404.`,
        );
      }
    })
    .catch(() => {
      // fetchRoutes never rejects, but stay defensive — a warning helper
      // must never be the thing that crashes a job.
    });
}

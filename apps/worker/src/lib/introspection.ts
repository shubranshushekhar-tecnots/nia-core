import type { IntrospectResponse } from "@nia/schemas";
import type { ResolvedConnection } from "./resolveConnection.js";
import { sendIntrospectRequest } from "./connectorClient.js";
import { env } from "../env.js";
import type { DispatchResult } from "./errors.js";

/**
 * In-memory, per-process cache of /introspect results, keyed like the
 * connector services' own pool cache (connectionId:credVersion) so a
 * credential rotation always busts it.
 *
 * That key alone isn't enough for the common case — schema drift without a
 * credential rotation (someone adds a column, cache is stale) — so this
 * also carries:
 *   1. A TTL (SCHEMA_CACHE_TTL_MS, default 5min): entries older than that
 *      are re-fetched even if the key still matches.
 *   2. Failure-driven invalidation: if a query later fails to dispatch
 *      against a cached schema, the caller (chat/nodes/dispatch.ts) calls
 *      invalidateSchema() and the pipeline re-introspects once before
 *      giving up.
 *
 * This is deliberately NOT real drift detection (no way to know a schema
 * changed without either hitting the TTL or a failed query) — just a way
 * to not be stale forever.
 */
type CacheEntry = { schema: IntrospectResponse; fetchedAt: number };

const cache = new Map<string, CacheEntry>();

function cacheKey(connection: ResolvedConnection): string {
  return `${connection.credential.connectionId}:${connection.credential.credVersion}`;
}

export async function getSchema(connection: ResolvedConnection): Promise<DispatchResult<IntrospectResponse>> {
  const key = cacheKey(connection);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < env.SCHEMA_CACHE_TTL_MS) {
    return { ok: true, value: cached.schema };
  }

  const result = await sendIntrospectRequest(connection.manifest, connection.credential, connection.config);
  if (!result.ok) return result;

  cache.set(key, { schema: result.value, fetchedAt: Date.now() });
  return result;
}

/** Drops a connection's cached schema — called after a query fails against it. */
export function invalidateSchema(connection: ResolvedConnection): void {
  cache.delete(cacheKey(connection));
}

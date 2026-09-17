import type { CredentialRef, IntrospectResponse } from "@nia/schemas";

/**
 * apps/api's own in-memory /introspect cache — same key shape
 * (connectionId:credVersion, so a credential rotation always busts it) and
 * TTL convention as apps/worker/src/lib/introspection.ts's cache, but a
 * SEPARATE cache, not literally shared: apps/api and apps/worker are
 * different processes with no shared memory, so "served from the existing
 * introspection cache" (the plan's wording) is honored in spirit — same
 * caching *strategy*, reused rather than reinvented — not literally the
 * same Map. A cross-process cache (e.g. Redis-backed) would remove this
 * duplication but is out of scope for this pass; see the Session 2 report.
 */
const TTL_MS = 5 * 60_000;

type CacheEntry = { schema: IntrospectResponse; fetchedAt: number };

const cache = new Map<string, CacheEntry>();

function cacheKey(credential: CredentialRef): string {
  return `${credential.connectionId}:${credential.credVersion}`;
}

export function getCachedSchema(credential: CredentialRef): IntrospectResponse | null {
  const entry = cache.get(cacheKey(credential));
  if (!entry || Date.now() - entry.fetchedAt >= TTL_MS) return null;
  return entry.schema;
}

export function setCachedSchema(credential: CredentialRef, schema: IntrospectResponse): void {
  cache.set(cacheKey(credential), { schema, fetchedAt: Date.now() });
}

/**
 * Phase 5 Session 5, Block 2 — busts this connection's cached entry.
 * refreshConnectionSchema() (services/connections.ts) calls this before
 * re-introspecting, so a stale schema (e.g. a since-renamed column) is
 * never served from THIS process's cache again even if the re-introspect
 * call fails. Separate from apps/worker/src/lib/introspection.ts's own
 * cache (different process, no shared memory) — see that refresh flow's
 * header comment for how both halves are cleared together.
 */
export function invalidateCachedSchema(credential: CredentialRef): void {
  cache.delete(cacheKey(credential));
}

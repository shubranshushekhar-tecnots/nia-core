import type { PlatformAgent } from "./types";

/**
 * Explicit whitelist mapping, not a cast — a raw /agents response can only
 * ever surface the fields picked out here. This is what makes the "Guard"
 * test (the one-time pairing code must never resurface anywhere, including
 * a later list/poll response) runtime-verifiable rather than a type-level
 * assumption: even if the API ever leaked a `code`/`agentKey` field on a
 * list row, mapAgent would silently drop it before it reaches rendered UI
 * state.
 */
export function mapAgent(raw: unknown): PlatformAgent {
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    displayName: String(row.displayName ?? ""),
    status: (row.status as PlatformAgent["status"]) ?? "pending",
    agentVersion: typeof row.agentVersion === "string" ? row.agentVersion : null,
    hostName: typeof row.hostName === "string" ? row.hostName : null,
    lastCheckInAt: typeof row.lastCheckInAt === "string" ? row.lastCheckInAt : null,
    createdByUserId: String(row.createdByUserId ?? ""),
    createdAt: String(row.createdAt ?? ""),
    online: Boolean(row.online),
  };
}

export function mapAgents(raw: unknown[]): PlatformAgent[] {
  return raw.map(mapAgent);
}

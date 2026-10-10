/**
 * `GET /status`: same bearer token as `/otc` (status.ts has no `auth` override -> default bearer
 * auth applies), so the tray can poll this directly -- no OTC/session dance needed for a read-only
 * status check. Returns `null` on ANY failure (network error, non-200, malformed body) so callers
 * can treat "service not running" and "service returned garbage" the same way.
 */
/** Phase 6 polish -- mirrors UpdateChecker.getPendingUpdate() (apps/agent/src/link/updateChecker.ts). */
export interface PendingUpdateInfo {
  version: string;
  readyToInstall: boolean;
}

export interface AgentStatusResponse {
  paired: boolean;
  platformUrl?: string;
  online?: boolean;
  revoked?: boolean;
  isSyncing?: boolean;
  pendingUpdate?: PendingUpdateInfo;
}

function parsePendingUpdate(value: unknown): PendingUpdateInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, readyToInstall } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof readyToInstall !== "boolean") return undefined;
  return { version, readyToInstall };
}

export async function fetchAgentStatus(port: number, token: string, fetchImpl: typeof fetch = fetch): Promise<AgentStatusResponse | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AgentStatusResponse>;
    if (typeof body.paired !== "boolean") return null;
    return {
      paired: body.paired,
      platformUrl: typeof body.platformUrl === "string" ? body.platformUrl : undefined,
      online: typeof body.online === "boolean" ? body.online : undefined,
      revoked: typeof body.revoked === "boolean" ? body.revoked : undefined,
      isSyncing: typeof body.isSyncing === "boolean" ? body.isSyncing : undefined,
      pendingUpdate: parsePendingUpdate(body.pendingUpdate),
    };
  } catch {
    return null;
  }
}

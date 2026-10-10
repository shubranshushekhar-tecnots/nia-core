/**
 * `GET /status`: same bearer token as `/otc` (status.ts has no `auth` override -> default bearer
 * auth applies), so the tray can poll this directly -- no OTC/session dance needed for a read-only
 * status check. Returns `null` on ANY failure (network error, non-200, malformed body) so callers
 * can treat "service not running" and "service returned garbage" the same way.
 */
export interface AgentStatusResponse {
  paired: boolean;
  platformUrl?: string;
  online?: boolean;
  revoked?: boolean;
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
    };
  } catch {
    return null;
  }
}

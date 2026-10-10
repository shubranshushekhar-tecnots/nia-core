/**
 * Mints a one-time code from the running agent's local API and builds the
 * URL the BrowserWindow should load -- the Electron equivalent of
 * apps/agent/src/cli/openCommand.ts's mintOtc + browser-open, except the
 * destination is our own window instead of the OS default browser.
 */
export class AgentNotRunningError extends Error {
  constructor() {
    super("Nia Core Agent isn't running -- start it first.");
    this.name = "AgentNotRunningError";
  }
}

export async function mintOtc(port: number, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/otc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AgentNotRunningError();
  }
  if (!res.ok) throw new AgentNotRunningError();
  let body: { otc?: unknown };
  try {
    body = (await res.json()) as { otc?: unknown };
  } catch {
    throw new AgentNotRunningError();
  }
  if (typeof body.otc !== "string" || body.otc.length === 0) throw new AgentNotRunningError();
  return body.otc;
}

export function buildLaunchUrl(port: number, otc: string): string {
  return `http://127.0.0.1:${port}/?otc=${otc}`;
}

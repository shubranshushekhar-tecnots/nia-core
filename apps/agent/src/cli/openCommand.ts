import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultHomeDir } from "../config/paths.js";
import { loadOrCreateApiToken } from "../localApi/authToken.js";
import { readPortFile } from "../localApi/portFile.js";

const execFileAsync = promisify(execFile);

/** The one plain-word failure mode this command can hit -- everything else (network error, non-200, malformed body) collapses into this same message, since there is nothing more specific a non-technical user could act on. */
export class AgentNotRunningError extends Error {
  constructor() {
    super("Nia Agent isn't running -- start it first.");
    this.name = "AgentNotRunningError";
  }
}

async function mintOtc(port: number, token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/otc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AgentNotRunningError();
  }
  if (!res.ok) throw new AgentNotRunningError();
  const body = (await res.json()) as { otc?: unknown };
  if (typeof body.otc !== "string" || body.otc.length === 0) throw new AgentNotRunningError();
  return body.otc;
}

/** `open`/`start` (macOS/Windows) take a bare URL fine; Linux's `xdg-open` too -- no shell involved (execFile, not exec), so the URL never passes through a shell. */
async function openInBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}

/**
 * `nia-agent open` (Phase 2 M2) -- the one plain-open entry point meant for
 * the default Start Menu / Applications shortcut. Reads the already-minted
 * long-lived bearer token straight off disk (same ACL'd `local-api/`
 * folder every other CLI command already trusts), trades it for a 60s
 * single-use OTC via the running agent's own `/otc` route, then opens the
 * OS default browser at `/?otc=<code>` -- the bearer token itself never
 * appears in a URL, a shortcut target, shell history, or browser JS.
 */
export async function runOpen(dir = defaultHomeDir()): Promise<void> {
  const portInfo = readPortFile(dir);
  if (!portInfo) throw new AgentNotRunningError();

  const token = loadOrCreateApiToken(dir);
  const otc = await mintOtc(portInfo.port, token);
  await openInBrowser(`http://127.0.0.1:${portInfo.port}/?otc=${otc}`);
}

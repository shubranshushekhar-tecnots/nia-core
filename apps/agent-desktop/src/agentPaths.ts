import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Deliberately duplicated from apps/agent/src/config/paths.ts (and
 * localApi/portFile.ts + authToken.ts) rather than imported: @nia/agent has
 * no `exports` map for subpath imports, and this is the one piece of its
 * internals a desktop *client* needs (read-only — never creates the token,
 * unlike the agent's own loadOrCreateApiToken). Keep in sync with that file
 * if the agent's data-dir layout ever changes.
 */
export function defaultHomeDir(): string {
  if (process.env.NIA_AGENT_HOME) return process.env.NIA_AGENT_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData ?? "C:\\ProgramData", "NiaAgent");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "NiaAgent");
  }
  return "/etc/nia-agent";
}

function localApiDir(dir: string): string {
  return path.join(dir, "local-api");
}

export interface LocalApiPortInfo {
  port: number;
  startedAt: string;
}

/** Returns `null` if the agent isn't running (file missing) or the file is corrupt -- never throws. */
export function readPortFile(dir = defaultHomeDir()): LocalApiPortInfo | null {
  try {
    const raw = fs.readFileSync(path.join(localApiDir(dir), "port.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalApiPortInfo>;
    if (typeof parsed.port !== "number" || typeof parsed.startedAt !== "string") return null;
    return { port: parsed.port, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/** Returns `null` if the token file doesn't exist yet -- this client never creates one (only the agent service does). */
export function readApiToken(dir = defaultHomeDir()): string | null {
  try {
    const token = fs.readFileSync(path.join(localApiDir(dir), "token"), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

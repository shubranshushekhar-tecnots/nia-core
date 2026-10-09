import fs from "node:fs";
import { defaultHomeDir, localApiDir, localApiPortFilePath } from "../config/paths.js";

export interface LocalApiPortInfo {
  port: number;
  startedAt: string;
}

/** Written once per successful bind (server.ts) -- the desktop app's only way to discover the actual port, since the default can fall back to `+1..+9` if it's taken. */
export function writePortFile(port: number, dir = defaultHomeDir()): void {
  const info: LocalApiPortInfo = { port, startedAt: new Date().toISOString() };
  // See authToken.ts's loadOrCreateApiToken for why this targets the
  // local-api subfolder (and why mkdirSync is safe to call unconditionally).
  fs.mkdirSync(localApiDir(dir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(localApiPortFilePath(dir), JSON.stringify(info), { mode: 0o600 });
}

/** Returns `null` if the agent isn't running (file missing) or the file is corrupt -- never throws. */
export function readPortFile(dir = defaultHomeDir()): LocalApiPortInfo | null {
  try {
    const raw = fs.readFileSync(localApiPortFilePath(dir), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalApiPortInfo>;
    if (typeof parsed.port !== "number" || typeof parsed.startedAt !== "string") return null;
    return { port: parsed.port, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

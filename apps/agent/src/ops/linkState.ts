import fs from "node:fs";
import { defaultHomeDir, linkStateFilePath } from "../config/paths.js";

/**
 * Slice L2 (docs/plans/agent-canvas-integration.md B.3/B.4): the check-in
 * loop's own run state, read by `agent status` (B item 4). Deliberately
 * separate from ops/state.ts's per-job files — a link failure must never
 * touch job state, and vice versa.
 */
export interface LinkState {
  lastCheckInAt?: string;
  revoked?: boolean;
}

function emptyLinkState(): LinkState {
  return {};
}

export function readLinkState(dir = defaultHomeDir()): LinkState {
  const file = linkStateFilePath(dir);
  if (!fs.existsSync(file)) return emptyLinkState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LinkState>;
    return { lastCheckInAt: parsed.lastCheckInAt, revoked: parsed.revoked };
  } catch {
    return emptyLinkState();
  }
}

export function writeLinkState(state: LinkState, dir = defaultHomeDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(linkStateFilePath(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Called by the check-in loop on every successful check-in — also clears a stale `revoked` flag (e.g. after a fresh `pair`). */
export function recordCheckInSuccess(dir = defaultHomeDir()): void {
  writeLinkState({ lastCheckInAt: new Date().toISOString(), revoked: false }, dir);
}

/** Called once when the loop sees a 401 — see CheckInLoop's "stop the link, log it once" rule (B item 3). */
export function recordRevoked(dir = defaultHomeDir()): void {
  const state = readLinkState(dir);
  writeLinkState({ ...state, revoked: true }, dir);
}

/** Called by `pair`/`unpair` so a stale check-in time/revoked flag from a previous pairing never leaks into a new one. */
export function clearLinkState(dir = defaultHomeDir()): void {
  writeLinkState({}, dir);
}

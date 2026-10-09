import { randomBytes } from "node:crypto";

/** Sliding-window inactivity timeout -- any `touchSession` call within this window refreshes it; a gap longer than this expires the session even though the cookie itself lives up to 24h (see routes/uiAuth.ts's `Set-Cookie`). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionEntry {
  lastSeenAt: number;
}

/** In-memory only -- lost on agent restart, which is fine: the desktop app just re-opens via `nia-agent open` and mints a fresh one. */
const sessions = new Map<string, SessionEntry>();

export function createSession(now = Date.now()): string {
  const id = randomBytes(32).toString("hex");
  sessions.set(id, { lastSeenAt: now });
  return id;
}

/** Refreshes `lastSeenAt` and returns `true` for a live session; deletes and returns `false` for a missing or expired one. */
export function touchSession(id: string, now = Date.now()): boolean {
  const entry = sessions.get(id);
  if (!entry) return false;
  if (now - entry.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return false;
  }
  entry.lastSeenAt = now;
  return true;
}

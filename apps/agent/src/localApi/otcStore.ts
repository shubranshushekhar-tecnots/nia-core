import { randomBytes } from "node:crypto";

const OTC_TTL_MS = 60_000;

interface OtcEntry {
  expiresAt: number;
}

/**
 * One-time codes for the `nia-agent open` → browser handoff: the CLI
 * (which already holds the real bearer token) mints a code via `POST
 * /otc`, the browser trades it for a session cookie via `POST
 * /ui/session`. In-memory only (lost on restart -- fine, a code is only
 * ever used seconds after being minted) and single-use -- `consumeOtc`
 * deletes on success *and* on expiry, so a code can never be replayed.
 */
const codes = new Map<string, OtcEntry>();

export function mintOtc(now = Date.now()): string {
  const code = randomBytes(32).toString("hex");
  codes.set(code, { expiresAt: now + OTC_TTL_MS });
  return code;
}

/** Single-use: valid codes are deleted on success. An expired code is deleted too (never left around to leak via timing). */
export function consumeOtc(code: string, now = Date.now()): boolean {
  const entry = codes.get(code);
  if (!entry) return false;
  codes.delete(code);
  return entry.expiresAt > now;
}

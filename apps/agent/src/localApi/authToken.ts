import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { defaultHomeDir, localApiDir, localApiTokenFilePath } from "../config/paths.js";

/** 32 random bytes, hex-encoded (64 chars) -- same entropy/encoding convention as the rest of this package's secrets. */
const TOKEN_LENGTH_BYTES = 32;

/**
 * Generated once (first `nia-agent start`) and reused across restarts --
 * same read-or-create pattern as `secrets/keyfile.ts`'s
 * `loadOrCreateMasterKey`. Every local API request must carry this
 * token; file permissions (inherited from the data dir's ACL) are the
 * only thing protecting it -- see docs/agent-local-api.md for the full
 * per-OS permissions model.
 */
export function loadOrCreateApiToken(dir = defaultHomeDir()): string {
  const file = localApiTokenFilePath(dir);
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token.length > 0) return token;
  }

  // mkdirSync is a no-op on an already-existing directory, so this never
  // resets an installer-applied ACL on a real install -- it only creates
  // the folder (with a permissive default) in dev/test/unpacked-zip runs
  // that never went through install.ps1/install.sh.
  fs.mkdirSync(localApiDir(dir), { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_LENGTH_BYTES).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Constant-time comparison -- a naive `===` would leak the token one
 * byte at a time via response-time differences. `timingSafeEqual`
 * itself requires equal-length buffers, so a length mismatch (e.g. an
 * empty or truncated header) is checked first and short-circuits to
 * `false` without ever calling it.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

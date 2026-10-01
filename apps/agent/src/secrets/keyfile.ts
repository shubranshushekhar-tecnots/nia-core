import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { defaultHomeDir, keyFilePath } from "../config/paths.js";
import { MASTER_KEY_LENGTH_BYTES } from "./crypto.js";

/**
 * v1 "secrets at rest" approach (docs/plans/planometry-integration.md Phase 2
 * §3, DECIDED): the master key lives in a plain file, protected only by OS
 * file permissions (0o600, owner-only) — no OS-native secret store, so no
 * native dependency on either Windows or Linux. Accepted limitation: anyone
 * with filesystem read access as the service account, or root/Administrator,
 * can read it. Upgrade path (Windows DPAPI / Linux libsecret) tracked in
 * TODO.md, not built now.
 */
export function loadOrCreateMasterKey(dir = defaultHomeDir()): Buffer {
  const file = keyFilePath(dir);
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file);
    if (key.length !== MASTER_KEY_LENGTH_BYTES) {
      throw new Error(`${file} is not a valid master key (expected ${MASTER_KEY_LENGTH_BYTES} bytes, got ${key.length})`);
    }
    return key;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(MASTER_KEY_LENGTH_BYTES);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

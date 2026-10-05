import { createHash, randomBytes } from "node:crypto";

/**
 * Long-lived agent API key, returned once from POST /pair. Only its hash
 * (agentKeyHash below) is ever stored — see 0069_platform_agents.sql's
 * column comment on platform_agents.agent_key_hash.
 */
export function generateAgentKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash-only storage discipline, same as invite_links.token_hash. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

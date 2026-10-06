/**
 * Minimum agent version the platform accepts a check-in from. Bumped by
 * hand when a breaking agent-protocol change ships; no DB migration is
 * involved — the bridge compares each check-in's reported version against
 * this constant, and the agent_version already stored on platform_agents
 * (0069_platform_agents.sql) is what the Agents page compares too.
 */
export const MIN_AGENT_VERSION = "0.0.1";

/**
 * Numeric, dot-separated version compare (e.g. "0.9.2" vs "0.10.0") —
 * deliberately not full semver (no pre-release/build-metadata handling)
 * since agent versions are plain `major.minor.patch` from package.json.
 * Returns true only when `version` is strictly older than `minVersion`;
 * an unparseable segment is treated as 0.
 */
export function isAgentVersionTooOld(version: string, minVersion: string): boolean {
  const a = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = minVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai < bi;
  }
  return false;
}

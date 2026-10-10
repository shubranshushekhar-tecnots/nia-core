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
 * Returns negative/0/positive the same way `Array.prototype.sort`'s
 * comparator does: `a` older than `b` -> negative, equal -> 0, `a` newer
 * -> positive. An unparseable segment is treated as 0. Shared by
 * `isAgentVersionTooOld` (bridge check-in gate) and `isNewerVersion`
 * (agent auto-update, Phase 6 polish) so both sides of the min-version /
 * update-available checks use the exact same comparison rules.
 */
export function compareAgentVersions(a: string, b: string): number {
  const partsA = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i] ?? 0;
    const bi = partsB[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/**
 * Returns true only when `version` is strictly older than `minVersion`.
 */
export function isAgentVersionTooOld(version: string, minVersion: string): boolean {
  return compareAgentVersions(version, minVersion) < 0;
}

/**
 * Returns true only when `candidate` is strictly newer than `current` —
 * the auto-update "is there actually something newer" guard
 * (apps/agent/src/link/updateChecker.ts). Never flags an equal or older
 * `candidate` as an update, which is also what keeps auto-update from
 * ever downgrading.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareAgentVersions(candidate, current) > 0;
}

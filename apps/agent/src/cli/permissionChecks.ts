import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { CheckResult } from "./doctorChecks.js";

const execFileAsync = promisify(execFile);

/**
 * `agent doctor`'s permission check: POSIX file modes (0o700/0o600, set by
 * config/store.ts, secrets/keyfile.ts, sync/spoolWriter.ts, ops/logger.ts)
 * have no effect on Windows — NTFS access is governed entirely by ACLs, set
 * once at install time by packaging/windows/install.ps1 (SYSTEM + local
 * Administrators only, inherited permissions removed). This is a read-only
 * diagnostic for both platforms: it never changes permissions, only warns
 * when a data directory/file is readable by more than the agent's own
 * account, so a widened ACL (e.g. someone running `icacls` by hand, or a
 * restore that reset permissions) gets caught by a routine `doctor` run
 * instead of silently exposing customer data.
 */
const WINDOWS_ALLOWED_IDENTITIES = [/^NT AUTHORITY\\SYSTEM$/i, /^BUILTIN\\ADMINISTRATORS$/i];

export async function checkPathPermissions(label: string, targetPath: string): Promise<CheckResult> {
  const name = `${label} permissions`;
  let info;
  try {
    info = await stat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { name, pass: true, detail: `${targetPath} does not exist yet — nothing to check` };
    }
    return { name, pass: false, severity: "warning", detail: err instanceof Error ? err.message : String(err) };
  }

  if (process.platform === "win32") {
    return checkWindowsAcl(name, targetPath);
  }
  return checkPosixMode(name, targetPath, info.mode, info.isDirectory());
}

function checkPosixMode(name: string, targetPath: string, mode: number, isDirectory: boolean): CheckResult {
  const bits = mode & 0o777;
  const tooOpen = (bits & 0o077) !== 0; // group or other has any access
  return {
    name,
    pass: !tooOpen,
    severity: "warning",
    detail: tooOpen
      ? `${targetPath} is mode ${bits.toString(8)} — group/other have access`
      : `${targetPath} is owner-only (mode ${bits.toString(8)})`,
    fix: tooOpen ? `chmod ${isDirectory ? "700" : "600"} ${targetPath}` : undefined,
  };
}

async function checkWindowsAcl(name: string, targetPath: string): Promise<CheckResult> {
  const fix = `icacls "${targetPath}" /inheritance:r /grant:r "NT AUTHORITY\\SYSTEM:(OI)(CI)F" "BUILTIN\\Administrators:(OI)(CI)F"`;
  try {
    const { stdout } = await execFileAsync("icacls", [targetPath]);
    const identities = parseIcaclsIdentities(stdout, targetPath);
    const unexpected = identities.filter((id) => !WINDOWS_ALLOWED_IDENTITIES.some((re) => re.test(id)));
    return {
      name,
      pass: unexpected.length === 0,
      severity: "warning",
      detail:
        unexpected.length === 0
          ? `${targetPath} is restricted to ${identities.join(", ") || "no identities (unable to parse icacls output)"}`
          : `${targetPath} grants access to unexpected identities: ${unexpected.join(", ")}`,
      fix: unexpected.length === 0 ? undefined : fix,
    };
  } catch (err) {
    return { name, pass: false, severity: "warning", detail: err instanceof Error ? err.message : String(err), fix };
  }
}

/** Exported for unit testing without a Windows host. icacls prints the path followed by the first ACE on one line, then one indented "identity:(flags)perm" line per further ACE, ending in a blank line + a "Successfully processed..." summary. */
export function parseIcaclsIdentities(stdout: string, targetPath: string): string[] {
  const identities = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim() || /^successfully processed/i.test(rawLine.trim())) continue;
    const line = rawLine.startsWith(targetPath) ? rawLine.slice(targetPath.length) : rawLine;
    const match = line.trim().match(/^([^:]+):/);
    if (match) identities.add(match[1]!.trim());
  }
  return [...identities];
}

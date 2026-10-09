import { execFile } from "node:child_process";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { localApiInstallingUserFilePath } from "../config/paths.js";
import type { CheckResult } from "./doctorChecks.js";

const execFileAsync = promisify(execFile);

/**
 * `agent doctor`'s permission check: POSIX file modes (0o700/0o600, set by
 * config/store.ts, secrets/keyfile.ts, sync/spoolWriter.ts, ops/logger.ts)
 * have no effect on Windows — NTFS access is governed entirely by ACLs, set
 * once at install time by packaging/windows/install.ps1 (the agent's own
 * virtual service account, "NT SERVICE\nia-agent", + local Administrators
 * only — not LocalSystem, per least privilege; inherited permissions
 * removed). This is a read-only diagnostic for both platforms: it never
 * changes permissions, only warns when a data directory/file is readable by
 * more than the agent's own account, so a widened ACL (e.g. someone running
 * `icacls` by hand, a restore that reset permissions, or the service
 * silently reverting to LocalSystem) gets caught by a routine `doctor` run
 * instead of silently exposing customer data.
 */
const WINDOWS_ALLOWED_IDENTITIES = [/^NT SERVICE\\NIA-AGENT$/i, /^BUILTIN\\ADMINISTRATORS$/i];

export async function checkPathPermissions(
  label: string,
  targetPath: string,
  extraAllowedWindowsIdentities: RegExp[] = [],
): Promise<CheckResult> {
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
    return checkWindowsAcl(name, targetPath, extraAllowedWindowsIdentities);
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

async function checkWindowsAcl(name: string, targetPath: string, extraAllowedWindowsIdentities: RegExp[] = []): Promise<CheckResult> {
  const fix = `icacls "${targetPath}" /inheritance:r /grant:r "NT SERVICE\\nia-agent:(OI)(CI)F" "BUILTIN\\Administrators:(OI)(CI)F"`;
  try {
    const { stdout } = await execFileAsync("icacls", [targetPath]);
    const identities = parseIcaclsIdentities(stdout, targetPath);
    const unexpected = findUnexpectedWindowsIdentities(identities, extraAllowedWindowsIdentities);
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

/**
 * Exported for unit testing without a Windows host — e.g. asserts that a
 * service account reverting to NT AUTHORITY\SYSTEM or LocalSystem gets
 * flagged, not silently allowed. `extraAllowed` is for the one directory
 * (`localApiDir()`) whose ACL legitimately has a third identity — the
 * user who ran install.ps1 — see `loadLocalApiExtraAllowedIdentities`.
 */
export function findUnexpectedWindowsIdentities(identities: string[], extraAllowed: RegExp[] = []): string[] {
  const allowed = [...WINDOWS_ALLOWED_IDENTITIES, ...extraAllowed];
  return identities.filter((id) => !allowed.some((re) => re.test(id)));
}

/**
 * Reads the `DOMAIN\user` (or local `user`) identity `install.ps1` recorded
 * for whoever ran it, so `checkPathPermissions("local-api directory", ...)`
 * knows that one extra ACE is expected on `localApiDir()` beyond the
 * service account and Administrators. Deliberately not gated on
 * `process.platform === "win32"` -- the marker file simply won't exist on
 * macOS/Linux or on an unpacked/non-installer run, so this naturally
 * returns `[]` there without needing to mock `process.platform` in tests.
 */
export function loadLocalApiExtraAllowedIdentities(dir: string): RegExp[] {
  try {
    const raw = fs.readFileSync(localApiInstallingUserFilePath(dir), "utf8");
    const parsed = JSON.parse(raw) as { identity?: unknown };
    if (typeof parsed.identity !== "string" || parsed.identity.length === 0) return [];
    const escaped = parsed.identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(`^${escaped}$`, "i")];
  } catch {
    return [];
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

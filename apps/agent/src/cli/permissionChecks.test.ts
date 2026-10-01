import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPathPermissions, findUnexpectedWindowsIdentities, parseIcaclsIdentities } from "./permissionChecks.js";

describe("checkPathPermissions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-permcheck-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when the path does not exist yet", async () => {
    const result = await checkPathPermissions("spool directory", path.join(dir, "does-not-exist"));
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/does not exist yet/);
  });

  // POSIX-only: Windows has no chmod-based mode bits, it's covered by the
  // icacls-parsing tests below instead.
  it.skipIf(process.platform === "win32")("passes for an owner-only directory (0700)", async () => {
    await chmod(dir, 0o700);
    const result = await checkPathPermissions("agent data directory", dir);
    expect(result.pass).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it.skipIf(process.platform === "win32")("warns when a directory is group/other readable", async () => {
    await chmod(dir, 0o750);
    const result = await checkPathPermissions("agent data directory", dir);
    expect(result.pass).toBe(false);
    expect(result.severity).toBe("warning");
    expect(result.fix).toMatch(/chmod 700/);
  });

  it.skipIf(process.platform === "win32")("warns when a file is group/other readable", async () => {
    const file = path.join(dir, "master.key");
    await writeFile(file, "fake-key");
    await chmod(file, 0o644);
    const result = await checkPathPermissions("secrets keyfile", file);
    expect(result.pass).toBe(false);
    expect(result.fix).toMatch(/chmod 600/);
  });

  it.skipIf(process.platform === "win32")("passes for an owner-only file (0600)", async () => {
    const file = path.join(dir, "master.key");
    await writeFile(file, "fake-key");
    await chmod(file, 0o600);
    const result = await checkPathPermissions("secrets keyfile", file);
    expect(result.pass).toBe(true);
  });
});

describe("parseIcaclsIdentities", () => {
  it("extracts identities from a locked-down ACL (virtual service account + Administrators only)", () => {
    const targetPath = "C:\\ProgramData\\NiaAgent";
    const stdout = [
      `${targetPath} NT SERVICE\\nia-agent:(OI)(CI)F`,
      "                 BUILTIN\\Administrators:(OI)(CI)F",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcaclsIdentities(stdout, targetPath)).toEqual(["NT SERVICE\\nia-agent", "BUILTIN\\Administrators"]);
  });

  it("surfaces an unexpected identity (e.g. a widened ACL) alongside the allowed ones", () => {
    const targetPath = "C:\\ProgramData\\NiaAgent";
    const stdout = [
      `${targetPath} NT SERVICE\\nia-agent:(OI)(CI)F`,
      "                 BUILTIN\\Administrators:(OI)(CI)F",
      "                 BUILTIN\\Users:(OI)(CI)R",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcaclsIdentities(stdout, targetPath)).toEqual(["NT SERVICE\\nia-agent", "BUILTIN\\Administrators", "BUILTIN\\Users"]);
  });
});

describe("findUnexpectedWindowsIdentities", () => {
  it("allows the virtual service account and local Administrators", () => {
    expect(findUnexpectedWindowsIdentities(["NT SERVICE\\nia-agent", "BUILTIN\\Administrators"])).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(findUnexpectedWindowsIdentities(["nt service\\nia-agent", "builtin\\administrators"])).toEqual([]);
  });

  it("flags NT AUTHORITY\\SYSTEM as unexpected — regression guard for the service silently reverting to LocalSystem", () => {
    expect(findUnexpectedWindowsIdentities(["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"])).toEqual(["NT AUTHORITY\\SYSTEM"]);
  });

  it("flags any other widened identity (e.g. BUILTIN\\Users)", () => {
    expect(findUnexpectedWindowsIdentities(["NT SERVICE\\nia-agent", "BUILTIN\\Administrators", "BUILTIN\\Users"])).toEqual([
      "BUILTIN\\Users",
    ]);
  });
});

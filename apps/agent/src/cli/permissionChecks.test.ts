import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localApiInstallingUserFilePath } from "../config/paths.js";
import {
  checkPathPermissions,
  findUnexpectedWindowsIdentities,
  loadLocalApiExtraAllowedIdentities,
  parseIcaclsIdentities,
} from "./permissionChecks.js";

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

  // The local-api directory legitimately has a third identity -- the user
  // who ran install.ps1 -- passed in via extraAllowed (loaded from the
  // installing-user.json marker file by loadLocalApiExtraAllowedIdentities).
  it("allows an extra identity when passed via extraAllowed", () => {
    expect(
      findUnexpectedWindowsIdentities(
        ["NT SERVICE\\nia-agent", "BUILTIN\\Administrators", "CONTOSO\\jdoe"],
        [/^CONTOSO\\jdoe$/i],
      ),
    ).toEqual([]);
  });

  it("still flags identities not covered by extraAllowed", () => {
    expect(
      findUnexpectedWindowsIdentities(
        ["NT SERVICE\\nia-agent", "BUILTIN\\Administrators", "BUILTIN\\Users"],
        [/^CONTOSO\\jdoe$/i],
      ),
    ).toEqual(["BUILTIN\\Users"]);
  });
});

describe("loadLocalApiExtraAllowedIdentities", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-permcheck-marker-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when the marker file doesn't exist (macOS/Linux, or an unpacked/non-installer run)", () => {
    expect(loadLocalApiExtraAllowedIdentities(dir)).toEqual([]);
  });

  it("returns a case-insensitive exact-match regex for the recorded identity", async () => {
    const markerPath = localApiInstallingUserFilePath(dir);
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({ identity: "CONTOSO\\jdoe" }));

    const [identity] = loadLocalApiExtraAllowedIdentities(dir);
    expect(identity).toBeDefined();
    expect(identity!.test("CONTOSO\\jdoe")).toBe(true);
    expect(identity!.test("contoso\\jdoe")).toBe(true);
    expect(identity!.test("CONTOSO\\other")).toBe(false);
  });

  it("escapes regex metacharacters in the recorded identity", async () => {
    const markerPath = localApiInstallingUserFilePath(dir);
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({ identity: "CONTOSO\\j.doe" }));

    const [identity] = loadLocalApiExtraAllowedIdentities(dir);
    expect(identity!.test("CONTOSO\\j.doe")).toBe(true);
    expect(identity!.test("CONTOSOXjXdoe")).toBe(false);
  });

  it("returns [] for malformed JSON or a missing/empty identity field", async () => {
    const markerPath = localApiInstallingUserFilePath(dir);
    await mkdir(path.dirname(markerPath), { recursive: true });

    await writeFile(markerPath, "not json");
    expect(loadLocalApiExtraAllowedIdentities(dir)).toEqual([]);

    await writeFile(markerPath, JSON.stringify({}));
    expect(loadLocalApiExtraAllowedIdentities(dir)).toEqual([]);

    await writeFile(markerPath, JSON.stringify({ identity: "" }));
    expect(loadLocalApiExtraAllowedIdentities(dir)).toEqual([]);
  });
});

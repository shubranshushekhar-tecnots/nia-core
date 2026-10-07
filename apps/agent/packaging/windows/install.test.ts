import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, "install.ps1"), "utf8");
const serviceXml = readFileSync(path.join(here, "nia-agent-service.xml"), "utf8");

describe("packaging/windows/nia-agent-service.xml", () => {
  // Regression test: a <serviceaccount> element makes WinSW resolve "NT
  // SERVICE\nia-agent" by name (LookupAccountName) during `install`, which
  // fails on a real Windows host with "FATAL - Failed to find the
  // account. No mapping between account names and security IDs was done."
  // The service must be registered with no account at all; install.ps1
  // assigns the virtual account afterward via `sc.exe config ... obj=`,
  // which the SCM special-cases instead of doing a generic name lookup.
  it("has no <serviceaccount> element", () => {
    expect(serviceXml).not.toContain("<serviceaccount>");
  });
});

describe("packaging/windows/install.ps1", () => {
  // Regression test: the service must be registered with no account
  // first (step a), then switched to the virtual account via `sc.exe
  // config ... obj=` (step b) — before any attempt to use that account's
  // SID for the data-dir ACL (step c) or to start the service (step d).
  // Doing the ACL or the start before the account switch either fails
  // outright (the account doesn't exist yet) or leaves the service
  // running as LocalSystem.
  it("registers the service, switches the account, sets permissions by SID, then starts — in that order", () => {
    const installIndex = script.indexOf("& $ServiceExe install");
    const configIndex = script.indexOf("sc.exe config nia-agent obj=");
    const showsidIndex = script.indexOf("sc.exe showsid nia-agent");
    const setAclIndex = script.indexOf("Set-Acl $DataDir $acl");
    const startIndex = script.indexOf("& $ServiceExe start");

    for (const index of [installIndex, configIndex, showsidIndex, setAclIndex, startIndex]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(installIndex).toBeLessThan(configIndex);
    expect(configIndex).toBeLessThan(showsidIndex);
    expect(showsidIndex).toBeLessThan(setAclIndex);
    expect(setAclIndex).toBeLessThan(startIndex);
  });

  // The data-dir ACL must be built from SID objects (service SID +
  // S-1-5-32-544 for Administrators), never from account name strings —
  // name-based FileSystemAccessRule construction is exactly what failed
  // on a real Windows host for the virtual service account.
  it("builds the data-dir ACL from SID objects, not account names", () => {
    expect(script).toContain('New-Object Security.Principal.SecurityIdentifier($serviceSidString)');
    expect(script).toContain('New-Object Security.Principal.SecurityIdentifier($AdministratorsSidString)');
    expect(script).toContain("New-Object Security.AccessControl.FileSystemAccessRule($identity,");
  });

  // On a failure switching the account or resolving/applying the SID-based
  // ACL, the just-registered service must be removed, not left behind
  // configured (and startable) as LocalSystem.
  it("removes the service on account or permission failure instead of leaving it as LocalSystem", () => {
    const configCatchBlock = script.slice(
      script.indexOf("sc.exe config nia-agent obj="),
      script.indexOf("Write-Log \"step b)"),
    );
    const aclCatchBlock = script.slice(
      script.indexOf("# Step c)"),
      script.indexOf("Write-Log \"step c) locked down"),
    );
    expect(configCatchBlock).toContain("Remove-ServiceQuietly");
    expect(aclCatchBlock).toContain("Remove-ServiceQuietly");
  });
});

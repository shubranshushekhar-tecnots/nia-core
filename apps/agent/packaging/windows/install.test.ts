import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, "install.ps1"), "utf8");
const serviceXml = readFileSync(path.join(here, "nia-agent-service.xml"), "utf8");
const nsis = readFileSync(path.join(here, "installer.nsi"), "utf8");

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

  // Step c2: the local-api subfolder (token + port files) must get its own
  // ACL, separate from the main data dir, granting read-only access to the
  // installing user's SID (not just service + Administrators) — see
  // paths.ts's localApiDir() doc comment for why a plain Administrators-only
  // grant isn't enough for a non-elevated desktop app to read it.
  describe("step c2 (local-api subfolder ACL)", () => {
    const step2Index = script.indexOf("# Step c2)");
    const step2Block = script.slice(step2Index, script.indexOf("# Step d)"));

    it("runs after step c's data-dir ACL and before step d's service start", () => {
      const setAclIndex = script.indexOf("Set-Acl $DataDir $acl");
      const startIndex = script.indexOf("& $ServiceExe start");
      expect(step2Index).toBeGreaterThan(-1);
      expect(setAclIndex).toBeLessThan(step2Index);
      expect(step2Index).toBeLessThan(startIndex);
    });

    it("creates a local-api subfolder under the data dir", () => {
      expect(step2Block).toContain('$LocalApiDir = Join-Path $DataDir "local-api"');
      expect(step2Block).toContain("New-Item -ItemType Directory -Force -Path $LocalApiDir");
    });

    it("grants the service and Administrators full control, and the installing user read-only, by SID", () => {
      expect(step2Block).toContain("([Security.Principal.WindowsIdentity]::GetCurrent()).User");
      expect(step2Block).toContain('FileSystemAccessRule($serviceSid, "FullControl"');
      expect(step2Block).toContain('FileSystemAccessRule($administratorsSid, "FullControl"');
      expect(step2Block).toContain('FileSystemAccessRule($installingUserSid, "ReadAndExecute"');
      expect(step2Block).toContain("Set-Acl $LocalApiDir $localApiAcl");
    });

    it("records the installing user's resolved identity in a marker file for `nia-agent doctor`", () => {
      expect(step2Block).toContain('$markerPath = Join-Path $LocalApiDir "installing-user.json"');
      expect(step2Block).toContain("identity = $installingUserName");
      expect(step2Block).toContain("ConvertTo-Json -Compress");
    });

    it("removes the service on local-api permission failure instead of leaving it behind", () => {
      expect(step2Block).toContain("Remove-ServiceQuietly");
      expect(step2Block).toContain('Fail "set local-api directory permissions"');
    });
  });

  // Regression test: RequestExecutionLevel admin means the installer
  // process is elevated, so a plain Exec of "Nia Agent.exe" (or
  // `nia-agent.exe open`) from the finish page would launch it running as
  // admin too -- wrong on its own, and it breaks the Electron app's
  // per-integrity-level single-instance lock. The fix launches through
  // "explorer.exe", which hands the launch off to the already-running,
  // non-elevated shell process for the interactive user instead.
  describe("RunSetupNow (finish-page launch)", () => {
    const fnBody = nsis.slice(
      nsis.indexOf("Function RunSetupNow"),
      nsis.indexOf("FunctionEnd", nsis.indexOf("Function RunSetupNow")),
    );

    it("launches via explorer.exe against the Start Menu shortcut instead of Exec'ing the app directly", () => {
      expect(fnBody).toContain('Exec \'explorer.exe "$SMPROGRAMS\\${START_MENU_DIR}\\Nia Core Agent.lnk"\'');
    });

    it("never Execs the Electron shell or nia-agent.exe directly (that would run it elevated)", () => {
      expect(fnBody).not.toContain('"$INSTDIR\\NiaAgentDesktop\\Nia Agent.exe"');
      expect(fnBody).not.toContain('"$INSTDIR\\nia-agent.exe" open');
    });
  });

  // Regression test for the real-Windows-11 failure: the installer
  // extracted files to the true 64-bit Program Files, but a 32-bit
  // install.ps1 process (launched via a WOW64-redirected $SYSDIR) computed
  // its install dir from $env:ProgramFiles, which WOW64 processes see as
  // "Program Files (x86)" — two different folders for the same install.
  it("launches 64-bit PowerShell via Sysnative and passes -InPlace", () => {
    expect(nsis).toContain('"$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"');
    expect(nsis).toContain("-File \"$INSTDIR\\install.ps1\" -InPlace");
  });

  // In-place mode (used by the installer) must use its own folder as the
  // install dir and never copy into it or delete it — the installer
  // already staged the files there via NSIS's own File command.
  it("in-place mode uses its own folder and never copies or deletes it", () => {
    expect(script).toContain("[switch]$InPlace");
    expect(script).toContain("$InstallDir = $ScriptDir");

    const copyBranchStart = script.indexOf("if ($InPlace) {", script.indexOf("Write-Log \"install.ps1 starting"));
    const inPlaceBranch = script.slice(copyBranchStart, script.indexOf("} else {", copyBranchStart));
    expect(inPlaceBranch).toContain("in-place mode");
    expect(inPlaceBranch).not.toContain("Copy-Item");
    expect(inPlaceBranch).not.toContain("Remove-Item -Recurse -Force $InstallDir");
  });

  // Replacing an existing service (any upgrade) must, in order: try a
  // graceful stop with a timeout, fall back to ending the process tree by
  // pid if that timed out, then delete the service and wait for it to
  // actually disappear before continuing — never just fire-and-forget the
  // stop/delete calls like 0.0.2 did.
  it("replaces an existing service by stopping (with timeout), ending its process tree, deleting, then waiting — in that order", () => {
    // Anchored past the -StopOnly early-exit block (used by installer.nsi's
    // pre-File-extraction hook), which has its own, separate copy of the
    // same stop/kill calls — searching from offset 0 would match those
    // instead of the main upgrade block this test actually describes.
    const mainBlockStart = script.indexOf("Write-Log \"install.ps1 starting");
    const stopIndex = script.indexOf("sc.exe stop nia-agent", mainBlockStart);
    const stopTimeoutIndex = script.indexOf('if (-not $stopped) {', mainBlockStart);
    const endProcessIndex = script.indexOf("Stop-ProcessTreeById -ParentId", mainBlockStart);
    const deleteIndex = script.indexOf("sc.exe delete nia-agent", mainBlockStart);
    const waitGoneIndex = script.indexOf("Wait-ServiceGone -TimeoutSec 30", mainBlockStart);

    for (const index of [stopIndex, stopTimeoutIndex, endProcessIndex, deleteIndex, waitGoneIndex]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(stopIndex).toBeLessThan(stopTimeoutIndex);
    expect(stopTimeoutIndex).toBeLessThan(endProcessIndex);
    expect(endProcessIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(waitGoneIndex);
  });

  it("ends the service's process tree by pid, never by image name", () => {
    expect(script).toContain("Stop-Process -Id $_.ProcessId -Force");
    expect(script).toContain("Stop-Process -Id $ParentId -Force");
  });

  it("stops with a plain message instead of continuing if the service is still marked for deletion", () => {
    expect(script).toContain(
      "An older Nia Core Agent service is still being removed. Close the Services window and Task Manager, or restart Windows, then run the installer again.",
    );
  });

  // Regression test for the real-Windows-11 failure: `Get-Service`
  // reported 'StartPending' immediately after `nia-agent-service.exe
  // start` returned, but `sc.exe query` a minute later showed RUNNING —
  // a single immediate check is a false failure. The verify step must
  // poll instead, treating StartPending as "keep waiting" rather than
  // a failure, succeed once Running has held for a few seconds, and
  // only fail on Stopped or on a timeout.
  describe("Wait-ServiceRunning", () => {
    const fnBody = script.slice(
      script.indexOf("function Wait-ServiceRunning"),
      script.indexOf("function Write-ServiceFailureDiagnostics"),
    );

    it("is defined and used (polling, not a single check) to verify the service started", () => {
      expect(fnBody).not.toBe("");
      expect(script).toContain("Wait-ServiceRunning -TimeoutSec 180 -StableSec 3");
    });

    it("only treats Stopped as an immediate failure — StartPending keeps waiting", () => {
      expect(fnBody).toContain('$lastStatus -eq "STOPPED"');
      expect(fnBody).toContain("return $false");
      expect(fnBody).not.toMatch(/START_PENDING[\s\S]{0,40}return \$false/);
    });

    it("requires the Running status to hold for a stable period before succeeding", () => {
      expect(fnBody).toContain("$runningSinceTicks");
      expect(fnBody).toContain("$elapsed -ge $StableSec");
    });

    it("polls once a second up to a timeout", () => {
      expect(fnBody).toContain("Start-Sleep -Seconds 1");
      expect(fnBody).toContain("$deadline");
    });

    // Regression test for a real production failure: install.ps1 only
    // ever runs under Windows PowerShell 5.1 (see installer.nsi's
    // GetPowerShellExe), never pwsh/PowerShell 7. Its older .NET-Framework
    // method binder cannot resolve DateTime's op_Subtraction overload for
    // `(Get-Date) - $runningSince` once $runningSince started life as
    // $null, throwing "Cannot find an overload for 'op_Subtraction' and
    // the argument count: '2'" the instant the service first reports
    // Running — a crash invisible under local pwsh testing (pwsh's binder
    // tolerates it) and invisible in CI too, since nothing was there yet
    // to catch and log the otherwise-silent terminating exception. Elapsed
    // time must be tracked via plain [long] tick counts (unambiguous Int64
    // subtraction) instead of DateTime arithmetic.
    it("tracks running-stability via tick counts, not DateTime subtraction", () => {
      expect(fnBody).toContain("(Get-Date).Ticks");
      expect(fnBody).not.toContain("= ((Get-Date) - $runningSince).TotalSeconds");
    });

    // Regression test: a `ServiceController` object from `Get-Service`
    // proved unreliable in CI — twice, including after adding `.Refresh()`
    // — reporting a stale `.Status` for an entire 180s polling loop while a
    // fresh `sc.exe query` process showed the true state throughout. Must
    // poll via `sc.exe query` text parsing instead, never `Get-Service`.
    it("polls via sc.exe query instead of Get-Service/ServiceController", () => {
      expect(fnBody).toContain("Get-ServiceStateViaScQuery");
      // NB: fnBody legitimately contains "Get-Service" (as a substring of its
      // own call to "Get-ServiceStateViaScQuery") and "ServiceController" (in
      // its explanatory doc-comment prose) — assert against the actual old-API
      // invocation/type-reference shapes instead of the bare substrings.
      expect(fnBody).not.toMatch(/Get-Service\s+(-Name\s+)?["']?nia-agent/);
      expect(fnBody).not.toMatch(/\[System\.ServiceProcess\.ServiceController\]|New-Object.*ServiceController/);
    });
  });

  // On a real start failure, the evidence (exit code, logs, event log)
  // must be captured before Remove-ServiceQuietly deletes the service —
  // not after, when it's gone.
  describe("Write-ServiceFailureDiagnostics", () => {
    it("is defined and called before Remove-ServiceQuietly in both post-start verify steps", () => {
      const verifyRunningBlock = script.slice(
        script.indexOf("if (-not (Wait-ServiceRunning"),
        script.indexOf("$qcOutput = & sc.exe qc nia-agent"),
      );
      const verifyAccountBlock = script.slice(
        script.indexOf("if (-not $startNameLine"),
        script.indexOf("Write-Log \"step d) verified"),
      );
      for (const block of [verifyRunningBlock, verifyAccountBlock]) {
        const diagIndex = block.indexOf("Write-ServiceFailureDiagnostics");
        const removeIndex = block.indexOf("Remove-ServiceQuietly");
        expect(diagIndex).toBeGreaterThan(-1);
        expect(removeIndex).toBeGreaterThan(-1);
        expect(diagIndex).toBeLessThan(removeIndex);
      }
    });

    it("captures the service's exit code, log tails, and event log entries", () => {
      const fnBody = script.slice(
        script.indexOf("function Write-ServiceFailureDiagnostics"),
        script.indexOf("Write-Log \"install.ps1 starting\""),
      );
      expect(fnBody).toContain("sc.exe query nia-agent");
      expect(fnBody).toContain("Get-Content -Path $logPath -Tail 20");
      expect(fnBody).toContain("Get-EventLog -LogName Application -Source \"nia-agent\"");
    });
  });
});

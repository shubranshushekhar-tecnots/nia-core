# Installs the Nia Agent as a Windows service via WinSW.
#
# Two modes:
#   - In-place (used by the NSIS installer, which passes -InPlace): the
#     install dir IS the folder this script already lives in ($PSScriptRoot,
#     already extracted there by NSIS into the real 64-bit Program Files).
#     Nothing is copied and this script's own folder is never deleted.
#   - Manual zip (default, no -InPlace): run as Administrator from an
#     unzipped nia-agent-windows-<version>.zip bundle (built by
#     build-bundle.mjs): .\install.ps1 — copies the bundle's files into
#     Program Files.
#
# Idempotent either way: safe to re-run with a newer bundle/installer to
# upgrade in place (stops the service, replaces the service registration,
# restarts) — %ProgramData%\NiaAgent (config/secrets/spool/logs/status) is
# never touched by this script, except for the install.log written here.
#
# 64-bit only, always: a 32-bit process on 64-bit Windows sees
# $env:ProgramFiles as "Program Files (x86)" (the OS substitutes it for
# WOW64 processes), which is exactly how v0.0.2 ended up installed to two
# different folders on a real Windows 11 host (NSIS extracted to the real
# 64-bit Program Files, but this script — launched as 32-bit PowerShell
# via the default $SYSDIR path, which WOW64-redirects to SysWOW64 — computed
# its install dir as Program Files (x86)). Fixed two ways: (1) this script
# relaunches itself under 64-bit PowerShell (via the "Sysnative" alias) if
# it ever finds itself running as a 32-bit process on 64-bit Windows, and
# (2) even without that, the install dir is computed from
# $env:ProgramW6432 (always the true 64-bit path, set only for WOW64
# processes) falling back to $env:ProgramFiles (already correct for a
# native 64-bit process).
#
# Prerequisites: .NET Framework 4.6.1+ (required by WinSW v2.x; included
# by default on Windows 10/Server 2016 and later — confirm on older hosts
# before installing).
#
# Account setup, in order (see nia-agent-service.xml for why): the
# service is registered with NO account (step a, defaults to LocalSystem
# but is never started that way), then immediately switched to the
# virtual account "NT SERVICE\nia-agent" via sc.exe config (step b) —
# sc.exe's `obj=` path is special-cased by the SCM for virtual/managed
# accounts and does not require the generic account-name-to-SID lookup
# that broke this on a real Windows 11 host. Once that succeeds, the
# account's SID (not its name — see below) is fetched via `sc.exe
# showsid` and used to build the data-dir ACL (step c) plus the update
# handoff dir ACL (step c3), and only then is the service started and
# verified (step d). Finally (step e) the external updater's own SYSTEM-
# principal Scheduled Task ("NiaAgentUpdater", see packaging/windows/
# updater/nia-agent-updater.ps1) is registered, with the service's virtual
# account granted only run rights on it (via the Task Scheduler COM API,
# since task permissions live in its own security descriptor, not an NTFS
# ACL) -- the service can trigger an update but can never reconfigure or
# delete the task that performs it. Any failure in b, c, c3, or e removes
# the just-registered service rather than leaving it configured to run as
# LocalSystem or without its updater task.
#
# CONFIRMED ON A REAL WINDOWS 11 HOST: generic Windows account-name
# resolution (LookupAccountName, which is what WinSW's <serviceaccount>
# install path and .NET's `New-Object
# Security.AccessControl.FileSystemAccessRule("NT SERVICE\nia-agent", ...)`
# both use internally) cannot resolve "NT SERVICE\nia-agent" — it is a
# virtual/per-service account, not a normal LSA account, and is only
# resolvable through the SCM's own SID-derivation path: `sc.exe config
# ... obj=` (which the SCM special-cases) and `sc.exe showsid` (which
# computes the SID directly, no name lookup involved). That mismatch
# produced exactly the two errors seen in the field: WinSW's own
# "FATAL - Failed to find the account. No mapping between account names
# and security IDs was done" during `install` (because the old XML asked
# WinSW to grant that account "Log on as a service" by name), followed by
# "Exception calling AddAccessRule ... Some or all identity references
# could not be translated" from the old data-dir ACL block (same name-
# lookup problem, hit a second time because PowerShell doesn't throw on a
# non-zero exit code from an external .exe, so the script kept going
# after the first failure).

param(
    # Passed by the NSIS installer: install in the folder this script is
    # already running from, instead of copying anywhere.
    [switch]$InPlace
)

$ErrorActionPreference = "Stop"

# When this script's whole process tree is ultimately launched from a
# pwsh (PowerShell 7+) parent -- as happens under GitHub Actions'
# `shell: pwsh` default, and will happen for any automation that drives
# the installer from pwsh -- $env:PSModulePath is inherited from that
# parent and already contains pwsh's own copy of
# Microsoft.PowerShell.Security alongside this (Windows PowerShell 5.1)
# process's copy. Simply prepending the WinPS5.1 directory is NOT enough
# to fix this (confirmed on a real run) -- WinPS5.1 still finds pwsh's
# copy too and refuses to load the module at all due to duplicate
# extended type data between the two copies, failing Get-Acl/Set-Acl
# below with "the module could not be loaded" even though the command
# was found. The only reliable fix is to throw away whatever
# $env:PSModulePath this process inherited and reset it to the clean,
# machine-level default (which only ever contains WinPS5.1's own module
# directories), regardless of what launched this process.
$env:PSModulePath = [Environment]::GetEnvironmentVariable("PSModulePath", "Machine")

# Relaunch under 64-bit PowerShell if this process is 32-bit on 64-bit
# Windows. "Sysnative" is a virtual alias that bypasses the WOW64
# file-system redirector that would otherwise turn it back into SysWOW64;
# it only exists for WOW64 processes, so a plain System32 path is correct
# for an already-64-bit process.
if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) {
    $sysnativePowerShell = Join-Path $env:WINDIR "Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    $relaunchArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $MyInvocation.MyCommand.Path)
    if ($InPlace) { $relaunchArgs += "-InPlace" }
    $proc = Start-Process -FilePath $sysnativePowerShell -ArgumentList $relaunchArgs -Wait -PassThru -NoNewWindow
    exit $proc.ExitCode
}

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "must run as Administrator"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Always the true 64-bit Program Files: $env:ProgramW6432 is set (to the
# real 64-bit path) only for WOW64 processes; a native 64-bit process has
# no need for it and already sees the correct path in $env:ProgramFiles.
$ProgramFiles64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
if ($InPlace) {
    $InstallDir = $ScriptDir
} else {
    $InstallDir = Join-Path $ProgramFiles64 "NiaAgent"
}
$DataDir = "$env:ProgramData\NiaAgent"
$ServiceExe = Join-Path $InstallDir "nia-agent-service.exe"
# Matches nia-agent-service.xml's comment and permissionChecks.ts's
# WINDOWS_ALLOWED_IDENTITIES — keep all three in sync if the service id
# ever changes.
$ServiceAccount = "NT SERVICE\nia-agent"
$AdministratorsSidString = "S-1-5-32-544"
# Well-known SYSTEM SID — the external updater (packaging/windows/updater/
# nia-agent-updater.ps1, step e below) runs as SYSTEM via a Scheduled Task,
# not as the service's own virtual account, so it needs its own grant on
# both the data dir (step c) and the update handoff dir (step c3) to read
# the manifest/port/token files and write its result file.
$SystemSidString = "S-1-5-18"
# Resolved once, up front (not per-SID-use) so the data-dir ACL (step c),
# the local-api subfolder ACL (step c2), and the update handoff dir ACL
# (step c3) all share the exact same SID objects, by well-known SID
# rather than by name.
$administratorsSid = New-Object Security.Principal.SecurityIdentifier($AdministratorsSidString)
$systemSid = New-Object Security.Principal.SecurityIdentifier($SystemSidString)

# Every step logs to the data folder; if that folder can't be created or
# written yet, fall back to %TEMP% so a failure is never silent.
try {
    New-Item -ItemType Directory -Force -Path $DataDir -ErrorAction Stop | Out-Null
    $LogFile = Join-Path $DataDir "install.log"
    "" | Out-File -FilePath $LogFile -Append -ErrorAction Stop
} catch {
    $LogFile = Join-Path $env:TEMP "nia-agent-install.log"
}

function Write-Log {
    param([string]$Message)
    $line = "$((Get-Date).ToString('o'))  $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# Run #12 showed install.ps1's own process disappearing less than half a
# second after its very first Wait-ServiceRunning status log line, on all
# 4 install attempts in that run, with no "FAILED at step" line, nothing
# in the NSIS-captured stdout/stderr, and nothing else in this log --
# i.e. a terminating exception that is currently invisible everywhere.
# A script-scope trap catches a terminating error raised anywhere in this
# script's call stack (including inside functions like Wait-ServiceRunning
# that have no try/catch of their own) and gives us one last chance to
# write out exactly what it was before the process exits, instead of it
# vanishing silently as it has been.
trap {
    Write-Log "UNCAUGHT EXCEPTION: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Write-Log "  at: $($_.InvocationInfo.PositionMessage -replace "`r?`n", ' | ')"
    Write-Log "  stack: $($_.ScriptStackTrace -replace "`r?`n", ' | ')"
    exit 1
}

function Fail {
    param([string]$Step, [string]$Detail)
    Write-Log "FAILED at step '$Step': $Detail"
    Write-Host ""
    Write-Host "Installation failed at step: $Step"
    Write-Host "See the full log at: $LogFile"
    exit 1
}

function Remove-ServiceQuietly {
    # Best-effort rollback after a failed account/ACL step — never leaves
    # the service registered (and therefore never running) as LocalSystem.
    try {
        & $ServiceExe stop 2>&1 | ForEach-Object { Write-Log "  $_" }
    } catch {}
    try {
        & $ServiceExe uninstall 2>&1 | ForEach-Object { Write-Log "  $_" }
    } catch {}
}

function Wait-ServiceGone {
    param([int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-ServiceStateViaScQuery {
    # `sc.exe query` calls QueryServiceStatusEx directly against the SCM in
    # a fresh process every time, with no object-level caching to go stale.
    # Returns the STATE token (e.g. "RUNNING", "START_PENDING", "STOPPED")
    # or "<not found>" if the service isn't registered / the query failed.
    $output = & sc.exe query nia-agent 2>&1
    $stateLine = $output | Where-Object { $_ -match "STATE\s*:\s*\d+\s*(\S+)" } | Select-Object -First 1
    if ($stateLine -and $stateLine -match "STATE\s*:\s*\d+\s*(\S+)") { return $matches[1] }
    return "<not found>"
}

function Wait-ServiceRunning {
    # WinSW's `start` returns as soon as it has asked the SCM to start the
    # service, not once the service has actually finished starting — on a
    # real Windows 11 host, Get-Service still reported StartPending at the
    # instant checked right after `start` returned, while `sc.exe query` a
    # minute later showed RUNNING. So: poll once a second for up to
    # $TimeoutSec, treating StartPending (or any other transitional state)
    # as "keep waiting"; succeed only once the service has been
    # continuously Running for $StableSec seconds; fail as soon as it
    # reaches Stopped, or once $TimeoutSec elapses without reaching that
    # stable point.
    #
    # Confirmed in CI (twice): a `ServiceController` object returned by
    # `Get-Service` can report a stale `.Status` that never changes across
    # an entire 180s polling loop on a loaded CI runner, while `sc.exe
    # query` run immediately afterwards in a fresh process correctly showed
    # RUNNING — and calling `.Refresh()` on the `ServiceController` before
    # reading `.Status` did NOT fix it (still timed out reporting "last
    # status: Running" with a live `sc.exe query` showing RUNNING the same
    # instant). So this polls `sc.exe query` directly instead of
    # `Get-Service`/`ServiceController` at all.
    #
    # That `sc.exe query`-based version STILL hit the identical symptom in
    # CI (timed out reporting "last status: RUNNING" with a diagnostic
    # `sc.exe query` moments later also showing RUNNING) — so the bug is not
    # (only) about which API reads the status, it's something about this
    # loop's own stability tracking never latching. Logging every status
    # *transition* (not every poll, to avoid log spam) so the next failure
    # shows the full state history across the 180s instead of just the
    # final snapshot.
    #
    # ROOT CAUSE FOUND (run #13, via the script-scope trap added after run
    # #12): every single failure above was the exact same bug —
    # `((Get-Date) - $runningSince).TotalSeconds` throws
    # "MethodException: Cannot find an overload for 'op_Subtraction' and
    # the argument count: '2'" under the real CI runtime, Windows
    # PowerShell 5.1 (confirmed via installer.nsi's GetPowerShellExe —
    # install.ps1 is never run under pwsh/PowerShell 7 in production,
    # only in this repo's own local testing). PowerShell 5.1's older
    # .NET-Framework method binder cannot resolve DateTime's op_Subtraction
    # overload when the right-hand side started life as $null, even after
    # being reassigned to a real [datetime] earlier in the same branch;
    # pwsh/PowerShell 7's binder tolerates this, which is exactly why every
    # local repro (always run under pwsh) "worked" while CI kept dying
    # silently right at this line, immediately after the first RUNNING
    # poll, well before Wait-ServiceRunning's own Fail()/timeout path ever
    # got a chance to run. Fixed by tracking elapsed time as plain [long]
    # tick counts instead of DateTime arithmetic — Int64 subtraction has
    # exactly one unambiguous overload on every PowerShell/.NET version, so
    # there is no overload resolution left to fail.
    param([int]$TimeoutSec, [int]$StableSec)
    $startTime = Get-Date
    $deadline = $startTime.AddSeconds($TimeoutSec)
    $runningSinceTicks = $null
    $lastStatus = "<not found>"
    $loggedStatus = $null
    $iteration = 0
    $lastHeartbeat = $startTime
    while ((Get-Date) -lt $deadline) {
        $iteration++
        $lastStatus = Get-ServiceStateViaScQuery
        if ($lastStatus -ne $loggedStatus) {
            # Reproduced this exact loop in isolation locally with a stubbed
            # status source and it latched correctly within ~4s — so if this
            # keeps timing out despite reaching RUNNING, the real sc.exe
            # text parsing must be returning a value that looks like
            # "RUNNING" but doesn't -eq it (e.g. stray characters). Dump the
            # length + char codes the first time each distinct value is seen
            # to catch that.
            $codes = ($lastStatus.ToCharArray() | ForEach-Object { [int]$_ }) -join ","
            Write-Log "  wait-service-running: status -> '$lastStatus' (len=$($lastStatus.Length) codes=$codes) (t=$([int]((Get-Date) - $startTime).TotalSeconds)s iter=$iteration)"
            $loggedStatus = $lastStatus
        }
        if (((Get-Date) - $lastHeartbeat).TotalSeconds -ge 15) {
            Write-Log "  wait-service-running: heartbeat iter=$iteration status='$lastStatus' runningSinceTicks=$runningSinceTicks t=$([int]((Get-Date) - $startTime).TotalSeconds)s"
            $lastHeartbeat = Get-Date
        }
        if ($lastStatus -eq "STOPPED") {
            Write-Log "  wait-service-running: status STOPPED - failing"
            return $false
        }
        if ($lastStatus -eq "RUNNING") {
            if ($null -eq $runningSinceTicks) {
                $runningSinceTicks = (Get-Date).Ticks
                Write-Log "  wait-service-running: runningSince SET (iter=$iteration)"
            }
            $elapsed = ((Get-Date).Ticks - $runningSinceTicks) / [double][TimeSpan]::TicksPerSecond
            if ($elapsed -ge $StableSec) {
                Write-Log "  wait-service-running: stable for ${elapsed}s >= ${StableSec}s - succeeding (iter=$iteration)"
                return $true
            }
        } else {
            if ($null -ne $runningSinceTicks) {
                Write-Log "  wait-service-running: runningSince RESET to null (lastStatus='$lastStatus') (iter=$iteration)"
            }
            # START_PENDING, etc. — not a failure, just not there yet.
            $runningSinceTicks = $null
        }
        Start-Sleep -Seconds 1
    }
    Write-Log "  wait-service-running: timed out after ${TimeoutSec}s (last status: $lastStatus)"
    return $false
}

function Write-ServiceFailureDiagnostics {
    # Captures everything needed to diagnose a real start failure before
    # Remove-ServiceQuietly deletes the service and that evidence goes
    # with it: the service's last exit code, the tail of both the WinSW
    # wrapper's logs and the agent's own log (same folder, see
    # nia-agent-service.xml), and any recent Application event-log
    # entries for it. Best-effort throughout — a diagnostics failure must
    # never block the actual cleanup/Fail that follows it.
    Write-Log "collecting failure diagnostics before removing the service"
    try {
        $queryOutput = & sc.exe query nia-agent 2>&1
        $queryOutput | ForEach-Object { Write-Log "  sc query: $_" }
        $queryOutput | Where-Object { $_ -match "WIN32_EXIT_CODE|SERVICE_EXIT_CODE" } | ForEach-Object {
            Write-Log "  last exit code: $($_.Trim())"
        }
    } catch {
        Write-Log "  WARN  sc.exe query failed: $($_.Exception.Message)"
    }

    $LogsDirForDiag = Join-Path $DataDir "logs"
    foreach ($logName in @("nia-agent.wrapper.log", "nia-agent.err.log", "nia-agent.out.log", "agent.log")) {
        $logPath = Join-Path $LogsDirForDiag $logName
        if (Test-Path $logPath) {
            Write-Log "  last 20 lines of ${logName}:"
            Get-Content -Path $logPath -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Log "    $_" }
        } else {
            Write-Log "  ($logName not found at $logPath)"
        }
    }

    try {
        $events = Get-EventLog -LogName Application -Source "nia-agent" -Newest 20 -ErrorAction Stop
        Write-Log "  recent Application event log entries for nia-agent:"
        $events | ForEach-Object { Write-Log "    $($_.TimeGenerated.ToString('o')) [$($_.EntryType)] $($_.Message)" }
    } catch {
        Write-Log "  (no Application event log entries found for nia-agent, or Get-EventLog failed: $($_.Exception.Message))"
    }
}

function Stop-ProcessTreeById {
    # Ends the service's wrapper process and its child (the agent process
    # WinSW spawned) by pid — never by image name, since multiple
    # unrelated processes can share an exe name.
    param([int]$ParentId)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Log "  ending child process pid $($_.ProcessId) ($($_.Name))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Log "  ending service process pid $ParentId"
    Stop-Process -Id $ParentId -Force -ErrorAction SilentlyContinue
}

Write-Log "install.ps1 starting (install dir: $InstallDir, data dir: $DataDir, in-place: $InPlace)"

# Replace an existing service robustly, regardless of where its files
# actually live (a previous install may have put them somewhere else
# entirely — see the WOW64 Program Files bug above). All of this talks to
# the service by name via the SCM, never by assuming its binary path.
$serviceWasRunning = $false
$existingInfo = Get-CimInstance Win32_Service -Filter "Name='nia-agent'" -ErrorAction SilentlyContinue
if ($existingInfo) {
    Write-Log "found existing nia-agent service: state=$($existingInfo.State) pid=$($existingInfo.ProcessId) path=$($existingInfo.PathName)"
    if ($existingInfo.State -eq "Running") {
        $serviceWasRunning = $true
        Write-Log "stopping existing nia-agent service for upgrade (30s timeout)"
        $stopOutput = & sc.exe stop nia-agent 2>&1
        $stopOutput | ForEach-Object { Write-Log "  sc stop: $_" }
        $deadline = (Get-Date).AddSeconds(30)
        $stopped = $false
        while ((Get-Date) -lt $deadline) {
            $svc = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
            if (-not $svc -or $svc.Status -eq "Stopped") { $stopped = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $stopped) {
            Write-Log "service did not stop within 30s; ending process tree by pid instead"
            if ($existingInfo.ProcessId -and $existingInfo.ProcessId -ne 0) {
                Stop-ProcessTreeById -ParentId $existingInfo.ProcessId
            }
        }
    }

    Write-Log "uninstalling existing nia-agent service for upgrade"
    $deleteOutput = & sc.exe delete nia-agent 2>&1
    $deleteOutput | ForEach-Object { Write-Log "  sc delete: $_" }
    if (-not (Wait-ServiceGone -TimeoutSec 30)) {
        Write-Log "FAILED: existing nia-agent service still present 30s after delete (likely marked for deletion)"
        Write-Host ""
        Write-Host "An older Nia Core Agent service is still being removed. Close the Services window and Task Manager, or restart Windows, then run the installer again."
        exit 1
    }
}
Write-Log "no existing nia-agent service blocking install"

# Best-effort cleanup of a previous install left behind in the 32-bit
# Program Files folder by the WOW64 bug described above. Never fails the
# install — the data folder (settings/secrets) is untouched either way.
$legacyX86Dir = Join-Path ${env:ProgramFiles(x86)} "NiaAgent"
if ((Test-Path $legacyX86Dir) -and ($legacyX86Dir -ne $InstallDir)) {
    try {
        Remove-Item -Recurse -Force $legacyX86Dir -ErrorAction Stop
        Write-Log "removed leftover 32-bit install at $legacyX86Dir"
    } catch {
        Write-Log "WARN  could not remove leftover $legacyX86Dir (non-fatal): $($_.Exception.Message)"
    }
}

if ($InPlace) {
    Write-Log "in-place mode: using $InstallDir as-is (files already staged there by the installer)"
} else {
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Path (Join-Path $ScriptDir "nia-agent.exe") -Destination $InstallDir
    Copy-Item -Path (Join-Path $ScriptDir "nia-agent-service.exe") -Destination $InstallDir
    Copy-Item -Path (Join-Path $ScriptDir "nia-agent-service.xml") -Destination $InstallDir
    Copy-Item -Path (Join-Path $ScriptDir "LICENSE-WinSW.txt") -Destination $InstallDir
}

# Step a) Register the service with no account in the XML (defaults to
# LocalSystem at registration time, but is never started this way).
try {
    & $ServiceExe install
    if ($LASTEXITCODE -ne 0) { throw "nia-agent-service.exe install exited with code $LASTEXITCODE" }
} catch {
    Fail "register service" $_.Exception.Message
}
Write-Log "step a) registered service 'nia-agent'"

# Step b) Switch it to the virtual account, before the first start.
# sc.exe's `obj=` assignment is special-cased by the SCM for virtual
# accounts and does not require LookupAccountName to succeed.
try {
    $configOutput = & sc.exe config nia-agent obj= $ServiceAccount 2>&1
    $configExit = $LASTEXITCODE
    $configOutput | ForEach-Object { Write-Log "  sc config: $_" }
    if ($configExit -ne 0) { throw "sc.exe config obj= exited with code $configExit" }
} catch {
    Remove-ServiceQuietly
    Fail "assign virtual service account" $_.Exception.Message
}
Write-Log "step b) switched service account to $ServiceAccount"

# Step c) Get the service's SID (not its name — see header comment) and
# lock down the data directory to it plus local Administrators only.
try {
    $showsidOutput = & sc.exe showsid nia-agent 2>&1
    $showsidOutput | ForEach-Object { Write-Log "  sc showsid: $_" }
    $sidLine = $showsidOutput | Where-Object { $_ -match "SERVICE SID:\s*(S-1-\S+)" } | Select-Object -First 1
    if (-not $sidLine) { throw "could not find a SERVICE SID line in sc.exe showsid output" }
    $serviceSidString = ($sidLine -replace ".*SERVICE SID:\s*", "").Trim()
    $serviceSid = New-Object Security.Principal.SecurityIdentifier($serviceSidString)
} catch {
    Remove-ServiceQuietly
    Fail "resolve service SID" $_.Exception.Message
}
Write-Log "step c) resolved service SID: $serviceSidString"

try {
    # Removing inherited permissions and granting only the service SID and
    # built-in Administrators (by well-known SID, not by name, so this
    # resolves identically on non-English Windows installs) — matches the
    # Linux install's 0700 data dir. POSIX file modes have no effect on
    # Windows, so this ACL is the only thing protecting config, secrets,
    # the master keyfile, and spool chunk files containing customer data.
    $acl = Get-Acl $DataDir
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($serviceSid, $administratorsSid, $systemSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
        $acl.AddAccessRule($rule)
    }
    Set-Acl $DataDir $acl
    # Recreated after the ACL so it inherits the locked-down permissions
    # instead of whatever %ProgramData%'s default was.
    $LogsDir = Join-Path $DataDir "logs"
    if (Test-Path $LogsDir) { Remove-Item -Recurse -Force $LogsDir }
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
} catch {
    Remove-ServiceQuietly
    Fail "set data directory permissions" $_.Exception.Message
}
Write-Log "step c) locked down $DataDir to $ServiceAccount, Administrators, and SYSTEM"

try {
    # Step c2) The local API's token and port files get their own ACL,
    # separate from the rest of $DataDir: service (full), Administrators
    # (full), SYSTEM (full — so the external updater's health check, step
    # e below, can read the port/token files to call its own GET /status),
    # and read-only for the SID of whoever is running this installer right
    # now. A non-elevated process under an admin account carries a
    # UAC-filtered token where Administrators is deny-only, so granting
    # that group alone would force a desktop app to elevate just to read
    # its own agent's token/port -- granting the specific user SID
    # (present in a token regardless of UAC filtering) avoids that without
    # widening the main data directory's ACL at all. The installing user's
    # resolved name is also recorded in a marker file so `nia-agent doctor`
    # knows which extra identity to expect here.
    $installingUserSid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User
    $LocalApiDir = Join-Path $DataDir "local-api"
    New-Item -ItemType Directory -Force -Path $LocalApiDir | Out-Null
    $localApiAcl = Get-Acl $LocalApiDir
    $localApiAcl.SetAccessRuleProtection($true, $false)
    $serviceFullControl = New-Object Security.AccessControl.FileSystemAccessRule($serviceSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $adminsFullControl = New-Object Security.AccessControl.FileSystemAccessRule($administratorsSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $systemFullControl = New-Object Security.AccessControl.FileSystemAccessRule($systemSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $installingUserReadOnly = New-Object Security.AccessControl.FileSystemAccessRule($installingUserSid, "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow")
    $localApiAcl.AddAccessRule($serviceFullControl)
    $localApiAcl.AddAccessRule($adminsFullControl)
    $localApiAcl.AddAccessRule($systemFullControl)
    $localApiAcl.AddAccessRule($installingUserReadOnly)
    Set-Acl $LocalApiDir $localApiAcl

    $installingUserName = $installingUserSid.Translate([Security.Principal.NTAccount]).Value
    $markerPath = Join-Path $LocalApiDir "installing-user.json"
    (@{ identity = $installingUserName } | ConvertTo-Json -Compress) | Out-File -FilePath $markerPath -Encoding utf8 -Force
} catch {
    Remove-ServiceQuietly
    Fail "set local-api directory permissions" $_.Exception.Message
}
Write-Log "step c2) locked down $LocalApiDir to $ServiceAccount (full), Administrators (full), SYSTEM (full), and $installingUserName (read-only)"

try {
    # Step c3) The external-updater handoff directory ($DataDir\update) —
    # written by the agent process (service account), read + written by
    # the SYSTEM-run updater task (nia-agent-updater.ps1, step e below).
    # Same FullControl-to-all-three pattern as the rest of this script:
    # no need for the finer-grained read-only split used on local-api,
    # since both identities here are already trusted to read/write the
    # rest of $DataDir anyway.
    $UpdateDir = Join-Path $DataDir "update"
    New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $UpdateDir "downloads") | Out-Null
    $updateAcl = Get-Acl $UpdateDir
    $updateAcl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($serviceSid, $administratorsSid, $systemSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
        $updateAcl.AddAccessRule($rule)
    }
    Set-Acl $UpdateDir $updateAcl
} catch {
    Remove-ServiceQuietly
    Fail "set update handoff directory permissions" $_.Exception.Message
}
Write-Log "step c3) locked down $UpdateDir to $ServiceAccount, Administrators, and SYSTEM"

# Step d) Start, then verify it is actually running under the virtual account.
try {
    & $ServiceExe start
    if ($LASTEXITCODE -ne 0) { throw "nia-agent-service.exe start exited with code $LASTEXITCODE" }
} catch {
    Remove-ServiceQuietly
    Fail "start service" $_.Exception.Message
}

if (-not (Wait-ServiceRunning -TimeoutSec 180 -StableSec 3)) {
    Write-ServiceFailureDiagnostics
    Remove-ServiceQuietly
    $finalSvc = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
    $finalStatus = if ($finalSvc) { $finalSvc.Status } else { "<not found>" }
    Fail "verify service running" "service did not reach a stable Running state within 180s (last status: $finalStatus)"
}

$qcOutput = & sc.exe qc nia-agent 2>&1
$qcOutput | ForEach-Object { Write-Log "  sc qc: $_" }
$startNameLine = $qcOutput | Where-Object { $_ -match "SERVICE_START_NAME" } | Select-Object -First 1
if (-not $startNameLine -or $startNameLine -notmatch [regex]::Escape($ServiceAccount)) {
    Write-ServiceFailureDiagnostics
    Remove-ServiceQuietly
    Fail "verify service account" "sc.exe qc did not report SERVICE_START_NAME as $ServiceAccount (got: $startNameLine)"
}
Write-Log "step d) verified nia-agent is Running (stable for 3s) under $ServiceAccount"

# Step e) Register the external updater's own Scheduled Task (SYSTEM
# principal, run on demand only -- no triggers) and restrict it so this
# service's own virtual account can only RUN it, never reconfigure or
# delete it. Scheduled Task permissions live in the task's own security
# descriptor (SDDL), not in NTFS ACLs, so this uses the Task Scheduler
# COM API directly rather than Set-Acl. -Force on Register-ScheduledTask
# makes this idempotent across upgrades (replaces the prior definition
# in place, same as the rest of this script's upgrade-in-place design).
try {
    # Invoked through run-updater.cmd (not powershell.exe directly) so any
    # failure before nia-agent-updater.ps1's own logging/trap can even run
    # (parse error, ExecutionPolicy/Group-Policy block, etc.) is still
    # captured in update\launcher.log -- Task Scheduler attaches no console
    # to a non-interactive task, so powershell.exe's own stdout/stderr would
    # otherwise be silently discarded in exactly that failure mode.
    $updaterLauncher = Join-Path $InstallDir "updater\run-updater.cmd"
    $action = New-ScheduledTaskAction -Execute $updaterLauncher
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
    $taskDefinition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName "NiaAgentUpdater" -InputObject $taskDefinition -Force | Out-Null

    # Restrict the service account to "run only": append a single ACE
    # granting GR (Generic Read) + GX (Generic Execute -- the right that
    # covers ITaskService::Run) to the service SID, on top of whatever
    # owner/DACL entries Register-ScheduledTask already set up (SYSTEM +
    # Administrators, full control). TASK_READ | TASK_EXECUTE is exactly
    # what `schtasks /run` (called from updateInstaller.ts's handoff) needs
    # and no more -- it cannot reconfigure, disable, or delete the task.
    $schedService = New-Object -ComObject "Schedule.Service"
    $schedService.Connect()
    $rootFolder = $schedService.GetFolder("\")
    $task = $rootFolder.GetTask("NiaAgentUpdater")
    $currentSddl = $task.GetSecurityDescriptor(0x4)  # DACL_SECURITY_INFORMATION
    $runOnlyAce = "(A;;GRGX;;;$serviceSidString)"
    if ($currentSddl -notlike "*$runOnlyAce*") {
        $task.SetSecurityDescriptor("$currentSddl$runOnlyAce", 0)
    }
} catch {
    Remove-ServiceQuietly
    Fail "register external updater scheduled task" $_.Exception.Message
}
Write-Log "step e) registered Scheduled Task 'NiaAgentUpdater' (SYSTEM, run-on-demand) with run-only rights for $ServiceAccount"

if ($serviceWasRunning) {
    Write-Host "upgraded and restarted nia-agent"
} else {
    Write-Host "installed and started nia-agent. Next steps:"
    Write-Host "  & `"$InstallDir\nia-agent.exe`" setup"
    Write-Host "  & `"$InstallDir\nia-agent.exe`" doctor"
    Write-Host "  Get-Service nia-agent"
}
Write-Log "install.ps1 finished successfully"

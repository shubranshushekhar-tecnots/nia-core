# Phase 6 external updater — runs as SYSTEM via the "NiaAgentUpdater"
# Scheduled Task (registered by install.ps1), triggered on-demand by the
# agent service (which only has rights to START this task — see
# install.ps1's task-registration step for the SID-scoped ACE that
# enforces that, and is the actual privilege boundary this whole design
# exists for).
#
# This script, NOT the agent service process, is what:
#   - independently re-verifies the downloaded installer's sha256 AND
#     Authenticode publisher (the agent process already checked sha256
#     once in updateChecker.ts before handing off — this is a second,
#     independently-trusted check, run from a context the agent process
#     cannot tamper with even if it were compromised);
#   - snapshots the current install directory before touching anything,
#     so a bad update can be undone;
#   - runs the real installer (already fully privileged as SYSTEM, no
#     elevation prompt needed — unlike the agent service's own low-
#     privilege account, which is exactly why it can't do this itself);
#   - polls the agent's own local API for a real post-install health
#     check (not the old "exit code 0 == healthy" assumption);
#   - restores the snapshot and re-registers the old version if the
#     health check fails;
#   - relaunches the Electron tray app in the logged-on user's own
#     interactive session afterward (a SYSTEM process has no session of
#     its own to launch a GUI app into).
#
# Lives at $InstallDir\updater\nia-agent-updater.ps1 — always derived
# from its own path below, never from %ProgramFiles%, so it works
# whether this install is at the real 64-bit Program Files or (in the
# -InPlace/NSIS case) wherever the installer actually staged things.
#
# Every step is best-effort/defensive: this script must never leave the
# machine with NO working agent install. If anything here cannot be
# verified safely, it refuses to install rather than guessing.

$ErrorActionPreference = "Stop"

$InstallDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = "$env:ProgramData\NiaAgent"
$UpdateDir = Join-Path $DataDir "update"
$RequestFile = Join-Path $UpdateDir "pending-update.json"
$InProgressFile = Join-Path $UpdateDir "in-progress.json"
$ResultFile = Join-Path $UpdateDir "last-result.json"
$LogFile = Join-Path $UpdateDir "updater.log"

New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null

function Write-Log {
    param([string]$Message)
    $line = "$((Get-Date).ToString('o'))  $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Write-Result {
    param([hashtable]$Result)
    ($Result | ConvertTo-Json -Compress) | Out-File -FilePath $ResultFile -Encoding utf8 -Force
}

trap {
    Write-Log "UNCAUGHT EXCEPTION: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Write-Log "  at: $($_.InvocationInfo.PositionMessage -replace "`r?`n", ' | ')"
    try { Write-Result @{ outcome = "error"; error = $_.Exception.Message } } catch {}
    exit 1
}

Write-Log "nia-agent-updater starting (install dir: $InstallDir)"

# Move (not copy) the request file before doing anything else, so a
# second concurrent `schtasks /run` (e.g. a user mashing "Check now")
# can never race this one on the same request — Move-Item is atomic on
# the same volume.
if (-not (Test-Path $RequestFile)) {
    Write-Log "no pending update request ($RequestFile not found) - nothing to do"
    exit 0
}
Move-Item -Path $RequestFile -Destination $InProgressFile -Force

$request = Get-Content -Path $InProgressFile -Raw | ConvertFrom-Json
$NewVersion = $request.version
$DownloadedFile = $request.filePath
$ExpectedSha256 = $request.sha256
Write-Log "processing update request: version=$NewVersion file=$DownloadedFile"

if (-not (Test-Path $DownloadedFile)) {
    Write-Log "FAILED: downloaded file not found at $DownloadedFile"
    Write-Result @{ outcome = "rejected"; reason = "file_missing"; version = $NewVersion }
    Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# --- 1) Independent sha256 re-verification ---------------------------
$actualSha256 = (Get-FileHash -Path $DownloadedFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    Write-Log "FAILED: sha256 mismatch (expected $ExpectedSha256, got $actualSha256) - refusing to install"
    Write-Result @{ outcome = "rejected"; reason = "checksum_mismatch"; version = $NewVersion }
    Remove-Item -Path $DownloadedFile -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Log "sha256 verified: $actualSha256"

# --- 2) Independent Authenticode publisher re-verification ------------
# `expected-publisher.json` is staged into $InstallDir at build time
# (build-installer.mjs/build-bundle.mjs, from sign.mjs's
# getExpectedPublisherSubject()) whenever a publisher subject was
# configured for this build. `UNSIGNED-TEST-BUILD.txt` is the existing
# build-release.mjs marker for a deliberate `--release --allow-unsigned`
# build — enforcement is skipped for THIS build's own self-updates only
# when that marker is present, never silently elsewhere. If neither
# file is present (an older build, or a dev build with no publisher
# configured), this falls back to sha256-only — a strict improvement
# over the old design (which never did more than that either), logged
# clearly either way so it is never a silent gap.
$unsignedMarker = Join-Path $InstallDir "UNSIGNED-TEST-BUILD.txt"
$expectedPublisherFile = Join-Path $InstallDir "expected-publisher.json"

if (Test-Path $unsignedMarker) {
    Write-Log "WARN  $unsignedMarker present - this is an unsigned test build; skipping publisher verification"
} elseif (Test-Path $expectedPublisherFile) {
    $expectedPublisher = (Get-Content -Path $expectedPublisherFile -Raw | ConvertFrom-Json).subject
    $signature = Get-AuthenticodeSignature -FilePath $DownloadedFile
    $subjectOk = $signature.SignerCertificate -and ($signature.SignerCertificate.Subject -like "*$expectedPublisher*")
    if ($signature.Status -ne "Valid" -or -not $subjectOk) {
        Write-Log "FAILED: Authenticode verification failed (status=$($signature.Status), subject='$($signature.SignerCertificate.Subject)', expected to contain '$expectedPublisher') - refusing to install"
        Write-Result @{ outcome = "rejected"; reason = "publisher_mismatch"; version = $NewVersion }
        Remove-Item -Path $DownloadedFile -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Log "Authenticode publisher verified: $($signature.SignerCertificate.Subject)"
} else {
    Write-Log "WARN  no expected-publisher.json staged in this install - proceeding on sha256 verification only"
}

# --- 3) Snapshot the current install for rollback ----------------------
$OldVersionLine = Get-Content -Path (Join-Path $InstallDir "VERSION.txt") -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Log "current install: $OldVersionLine"
$BackupDir = Join-Path $UpdateDir ("backup-" + (Get-Date).ToString("yyyyMMdd-HHmmss"))
Write-Log "snapshotting $InstallDir -> $BackupDir"
# robocopy (not Copy-Item) — tolerant of transient file locks and handles
# a large directory tree (including NiaAgentDesktop\) more robustly.
# Exit codes 0-7 are all "success" for robocopy; 8+ is a real failure.
& robocopy.exe $InstallDir $BackupDir /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Log "FAILED: robocopy snapshot exited $LASTEXITCODE - refusing to install without a rollback snapshot"
    Write-Result @{ outcome = "rejected"; reason = "snapshot_failed"; version = $NewVersion }
    Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Log "snapshot complete"

# --- 4) Run the installer (already SYSTEM — no elevation needed) -------
Write-Log "running installer silently: $DownloadedFile /S"
# -NoNewWindow (not -WindowStyle): Start-Process defaults to UseShellExecute
# = true (ShellExecuteEx) unless -NoNewWindow/-RedirectStandard*/-Credential
# is given, and ShellExecuteEx requires an interactive window station/desktop
# -- unavailable to this SYSTEM Scheduled Task session, so it throws "This
# command cannot be run due to the error: The operation attempted is not
# supported." -NoNewWindow forces the CreateProcess path instead (no shell,
# no window station needed), confirmed fixed against CI's actual failure.
#
# No -Wait here -- bound the wait manually instead. Observed on CI: the
# installer's actual effects (service stopped, binaries replaced, new
# service started and healthy) reliably complete within ~20-25s, same as an
# interactive /S run -- but the launched process handle itself has been seen
# to never signal exit under this SYSTEM/non-interactive Scheduled Task
# session (suspected NSIS self-relaunch or pipe/handle inheritance quirk
# specific to a CreateProcess-with-no-window launch; not fully isolated).
# An unbounded -Wait would hang this task forever on that quirk, which also
# blocks every subsequent update attempt (Task Scheduler won't start a second
# instance of a task it still considers running). Give it a generous ceiling
# (10x+ the normal runtime); if exceeded, kill it and fall through to the
# real health check below rather than assuming failure -- the timeout means
# the launching process's own signal can't be trusted, not that the install
# itself didn't work (observed CI runs where it silently succeeded despite
# the hang), so let the same "poll /status for the new version" check that
# already covers "exit code 0 but didn't actually come up" decide the truth.
#
# Explicitly redirect stdout/stderr to real files rather than leaving them
# un-redirected. This SYSTEM Scheduled Task session has no allocated
# console, and -NoNewWindow without redirection means .NET's Process class
# tries to inherit nonexistent console handles -- observed on CI to result
# in a process that exits normally (well within the 180s bound above, in
# practice ~25-35s) but whose ExitCode then reads back as $null instead of
# the real value, which previously looked like "exit code 0" failing the
# `-ne 0` check and rolling back a good install every time. Redirecting
# forces .NET to manage real pipe handles instead, which is the documented
# fix for Start-Process/ExitCode reliability in non-interactive sessions.
$installerStdOut = Join-Path $UpdateDir "installer-stdout.log"
$installerStdErr = Join-Path $UpdateDir "installer-stderr.log"
$proc = Start-Process -FilePath $DownloadedFile -ArgumentList "/S" -PassThru -NoNewWindow -RedirectStandardOutput $installerStdOut -RedirectStandardError $installerStdErr
$installerTimedOut = -not $proc.WaitForExit(180000)

function Restore-Snapshot {
    param([string]$Reason)
    Write-Log "restoring snapshot from $BackupDir (reason: $Reason)"
    & "$InstallDir\nia-agent-service.exe" stop 2>&1 | ForEach-Object { Write-Log "  $_" }
    & robocopy.exe $BackupDir $InstallDir /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Log "CRITICAL: restore robocopy exited $LASTEXITCODE - install dir may be inconsistent, manual intervention required"
    }
    try {
        & "$InstallDir\install.ps1" -InPlace 2>&1 | ForEach-Object { Write-Log "  restore install.ps1: $_" }
    } catch {
        Write-Log "CRITICAL: re-running install.ps1 after restore failed: $($_.Exception.Message)"
    }
}

if ($installerTimedOut) {
    Write-Log "WARN  installer process (pid $($proc.Id)) did not exit within 180s - killing it and its children, then checking real agent health below to determine whether the install actually took effect"
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
} else {
    # MSDN's own remarks on WaitForExit(Int32): after the timeout-overload
    # returns true, call the parameterless WaitForExit() once more so the
    # process's exit bookkeeping (including ExitCode) is guaranteed to be
    # fully synchronized before reading it -- without this, ExitCode can
    # read back as $null here even though the process has genuinely exited,
    # and `$null -ne 0` is $true in PowerShell, which previously caused a
    # false "installer failed" rollback of a perfectly good install.
    $proc.WaitForExit()
    Write-Log "installer exited with code $($proc.ExitCode)"
}

if (-not $installerTimedOut -and $proc.ExitCode -ne 0) {
    Restore-Snapshot -Reason "installer exited $($proc.ExitCode)"
    Write-Result @{ outcome = "rolled_back"; attemptedVersion = $NewVersion; reason = "installer_failed" }
    Remove-Item -Path $DownloadedFile -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# --- 5) Real health check — poll the agent's own local API -------------
function Test-AgentHealthy {
    param([string]$ExpectedVersion)
    try {
        $portFile = Join-Path $DataDir "local-api\port.json"
        $tokenFile = Join-Path $DataDir "local-api\token"
        if (-not (Test-Path $portFile) -or -not (Test-Path $tokenFile)) { return $false }
        $port = (Get-Content -Path $portFile -Raw | ConvertFrom-Json).port
        $token = (Get-Content -Path $tokenFile -Raw).Trim()
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
        return $response.agentVersion -eq $ExpectedVersion
    } catch {
        return $false
    }
}

Write-Log "polling local API for healthy startup at version $NewVersion (up to 5 minutes)"
$healthy = $false
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
    if (Test-AgentHealthy -ExpectedVersion $NewVersion) { $healthy = $true; break }
    Start-Sleep -Seconds 5
}

if (-not $healthy) {
    Write-Log "FAILED: agent did not report healthy at version $NewVersion within 5 minutes"
    Restore-Snapshot -Reason "health check failed"
    Write-Result @{ outcome = "rolled_back"; attemptedVersion = $NewVersion; reason = "health_check_failed" }
    Remove-Item -Path $DownloadedFile -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Log "healthy at version $NewVersion - update succeeded"
Remove-Item -Recurse -Force -Path $BackupDir -ErrorAction SilentlyContinue
Remove-Item -Path $DownloadedFile -Force -ErrorAction SilentlyContinue
Remove-Item -Path $InProgressFile -Force -ErrorAction SilentlyContinue
Write-Result @{ outcome = "installed"; version = $NewVersion }

# --- 6) Relaunch the tray app in the logged-on user's session ----------
# A SYSTEM process has no interactive session of its own — launching a
# GUI app directly here would either fail outright or (via the legacy
# "allow service to interact with desktop" flag, not used here) land on
# session 0's non-interactive "desktop", invisible to the actual user.
# The standard fix: a second, one-time Scheduled Task whose Principal IS
# the specific logged-on user (LogonType Interactive), so the OS itself
# launches the process in that user's session — no WTSQueryUserToken/
# CreateProcessAsUser P/Invoke needed.
try {
    $TrayExe = Join-Path $InstallDir "NiaAgentDesktop\Nia Agent.exe"
    if (-not (Test-Path $TrayExe)) {
        Write-Log "no NiaAgentDesktop\Nia Agent.exe staged (service-only build) - skipping tray relaunch"
    } else {
        $loggedOnUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
        if (-not $loggedOnUser) {
            Write-Log "no interactively logged-on user detected - skipping tray relaunch (it will start normally at next login via its own auto-launch setting)"
        } else {
            Write-Log "relaunching tray app for logged-on user $loggedOnUser"
            & taskkill.exe /F /IM "Nia Agent.exe" /T 2>&1 | ForEach-Object { Write-Log "  taskkill: $_" }
            Start-Sleep -Seconds 2

            $relaunchTaskName = "NiaAgentTrayRelaunch"
            $action = New-ScheduledTaskAction -Execute $TrayExe
            $principal = New-ScheduledTaskPrincipal -UserId $loggedOnUser -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            Register-ScheduledTask -TaskName $relaunchTaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
            Start-ScheduledTask -TaskName $relaunchTaskName
            Start-Sleep -Seconds 5
            Unregister-ScheduledTask -TaskName $relaunchTaskName -Confirm:$false -ErrorAction SilentlyContinue
            Write-Log "tray relaunch task triggered and cleaned up"
        }
    }
} catch {
    # Best-effort — a failed relaunch never undoes an otherwise-successful,
    # already-reported-healthy update. The user can reopen the tray app
    # manually (it also auto-starts at next login via its own setting).
    Write-Log "WARN  tray relaunch failed (non-fatal): $($_.Exception.Message)"
}

Write-Log "nia-agent-updater finished"
exit 0

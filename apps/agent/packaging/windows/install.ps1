# Installs the Nia Agent as a Windows service via WinSW. Run as
# Administrator on the target Windows host, from an unzipped
# nia-agent-windows-<version>.zip bundle (built by build-bundle.mjs):
#   .\install.ps1
#
# Idempotent: safe to re-run with a newer bundle to upgrade in place
# (stops the service, replaces the install dir, restarts) —
# %ProgramData%\NiaAgent (config/secrets/spool/logs/status) is never
# touched by this script, except for the install.log written here.
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
# showsid` and used to build the data-dir ACL (step c), and only then is
# the service started and verified (step d). Any failure in b or c
# removes the just-registered service rather than leaving it configured
# to run as LocalSystem.
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

$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "must run as Administrator"
    exit 1
}

$InstallDir = "$env:ProgramFiles\NiaAgent"
$DataDir = "$env:ProgramData\NiaAgent"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceExe = Join-Path $InstallDir "nia-agent-service.exe"
# Matches nia-agent-service.xml's comment and permissionChecks.ts's
# WINDOWS_ALLOWED_IDENTITIES — keep all three in sync if the service id
# ever changes.
$ServiceAccount = "NT SERVICE\nia-agent"
$AdministratorsSidString = "S-1-5-32-544"

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

Write-Log "install.ps1 starting (install dir: $InstallDir, data dir: $DataDir)"

$serviceWasRunning = $false
$existing = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq "Running") {
    $serviceWasRunning = $true
    Write-Log "stopping existing nia-agent service for upgrade"
    & $ServiceExe stop
    Start-Sleep -Seconds 2
}
if ($existing) {
    Write-Log "uninstalling existing nia-agent service for upgrade"
    & $ServiceExe uninstall
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $ScriptDir "nia-agent.exe") -Destination $InstallDir
Copy-Item -Path (Join-Path $ScriptDir "nia-agent-service.exe") -Destination $InstallDir
Copy-Item -Path (Join-Path $ScriptDir "nia-agent-service.xml") -Destination $InstallDir
Copy-Item -Path (Join-Path $ScriptDir "LICENSE-WinSW.txt") -Destination $InstallDir

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
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier($AdministratorsSidString)
    foreach ($identity in @($serviceSid, $administratorsSid)) {
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
Write-Log "step c) locked down $DataDir to $ServiceAccount and Administrators"

# Step d) Start, then verify it is actually running under the virtual account.
try {
    & $ServiceExe start
    if ($LASTEXITCODE -ne 0) { throw "nia-agent-service.exe start exited with code $LASTEXITCODE" }
} catch {
    Remove-ServiceQuietly
    Fail "start service" $_.Exception.Message
}

$qcOutput = & sc.exe qc nia-agent 2>&1
$qcOutput | ForEach-Object { Write-Log "  sc qc: $_" }
$startNameLine = $qcOutput | Where-Object { $_ -match "SERVICE_START_NAME" } | Select-Object -First 1
$svc = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
if (-not $svc -or $svc.Status -ne "Running") {
    $status = if ($svc) { $svc.Status } else { "<not found>" }
    Remove-ServiceQuietly
    Fail "verify service running" "Get-Service reported status '$status'"
}
if (-not $startNameLine -or $startNameLine -notmatch [regex]::Escape($ServiceAccount)) {
    Remove-ServiceQuietly
    Fail "verify service account" "sc.exe qc did not report SERVICE_START_NAME as $ServiceAccount (got: $startNameLine)"
}
Write-Log "step d) verified nia-agent is Running under $ServiceAccount"

if ($serviceWasRunning) {
    Write-Host "upgraded and restarted nia-agent"
} else {
    Write-Host "installed and started nia-agent. Next steps:"
    Write-Host "  & `"$InstallDir\nia-agent.exe`" setup"
    Write-Host "  & `"$InstallDir\nia-agent.exe`" doctor"
    Write-Host "  Get-Service nia-agent"
}
Write-Log "install.ps1 finished successfully"

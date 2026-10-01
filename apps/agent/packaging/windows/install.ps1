# Installs the Nia Agent as a Windows service via WinSW. Run as
# Administrator on the target Windows host, from an unzipped
# nia-agent-windows-<version>.zip bundle (built by build-bundle.mjs):
#   .\install.ps1
#
# Idempotent: safe to re-run with a newer bundle to upgrade in place
# (stops the service, replaces the install dir, restarts) —
# %ProgramData%\NiaAgent (config/secrets/spool/logs/status) is never
# touched by this script.
#
# Prerequisites: .NET Framework 4.6.1+ (required by WinSW v2.x; included
# by default on Windows 10/Server 2016 and later — confirm on older hosts
# before installing).

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
# Matches nia-agent-service.xml's <serviceaccount> (domain NT SERVICE, user
# nia-agent) and permissionChecks.ts's WINDOWS_ALLOWED_IDENTITIES — keep all
# three in sync if the service id ever changes.
$ServiceAccount = "NT SERVICE\nia-agent"

$serviceWasRunning = $false
$existing = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq "Running") {
    $serviceWasRunning = $true
    & $ServiceExe stop
    Start-Sleep -Seconds 2
}
if ($existing) {
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

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Restrict to the agent's own virtual service account (least privilege — the
# service runs as $ServiceAccount, not LocalSystem/SYSTEM) and local
# Administrators only, removing inherited permissions — matches the Linux
# install's 0700 data dir. POSIX file modes (0o700/0o600) have no effect on
# Windows, so this ACL is the only thing protecting config, secrets, the
# master keyfile, and spool chunk files containing customer row data. Must
# run BEFORE any subdirectory (e.g. "logs") is created below, so that
# subdirectory inherits this locked-down ACL instead of %ProgramData%'s
# default (which grants Users/Authenticated Users access).
# UNVERIFIED ON A REAL WINDOWS HOST: that a virtual service account's SID is
# resolvable via Get-Acl/New-Object FileSystemAccessRule before the service
# has ever been installed (Microsoft docs say virtual-account SIDs are
# deterministic and don't require prior provisioning, but this hasn't been
# exercised against a live SCM here). If Set-Acl below throws "account could
# not be translated", move this ACL block to after `& $ServiceExe install`.
$acl = Get-Acl $DataDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($ServiceAccount, "BUILTIN\Administrators")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl $DataDir $acl
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "logs") | Out-Null

& $ServiceExe install

if ($serviceWasRunning) {
    & $ServiceExe start
    Write-Host "upgraded and restarted nia-agent"
} else {
    Write-Host "installed. Next steps:"
    Write-Host "  & `"$InstallDir\nia-agent.exe`" connection add ..."
    Write-Host "  & `"$InstallDir\nia-agent.exe`" doctor"
    Write-Host "  & `"$ServiceExe`" start"
    Write-Host "  Get-Service nia-agent"
}

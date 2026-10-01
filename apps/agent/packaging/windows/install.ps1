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
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "logs") | Out-Null
# Restrict to SYSTEM (the service runs as LocalSystem by WinSW default)
# and local Administrators — matches the Linux install's 0700 data dir.
$acl = Get-Acl $DataDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl $DataDir $acl

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

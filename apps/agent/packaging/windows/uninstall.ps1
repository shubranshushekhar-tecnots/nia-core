# Uninstalls the Nia Agent Windows service. Run as Administrator from the
# install directory (or pass -InstallDir):
#   .\uninstall.ps1              # keeps %ProgramData%\NiaAgent (config/secrets/spool/logs)
#   .\uninstall.ps1 -Purge       # also removes %ProgramData%\NiaAgent

param(
    [switch]$Purge,
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"

if (-not $InstallDir) {
    # Always the true 64-bit Program Files — see install.ps1's header
    # comment for why $env:ProgramFiles alone isn't safe here.
    $ProgramFiles64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
    $InstallDir = Join-Path $ProgramFiles64 "NiaAgent"
}

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "must run as Administrator"
    exit 1
}

$ServiceExe = Join-Path $InstallDir "nia-agent-service.exe"
$existing = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq "Running") {
        & $ServiceExe stop
        Start-Sleep -Seconds 2
    }
    & $ServiceExe uninstall
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
}

if ($Purge) {
    $DataDir = "$env:ProgramData\NiaAgent"
    if (Test-Path $DataDir) {
        Remove-Item -Recurse -Force $DataDir
    }
    Write-Host "uninstalled nia-agent and removed $DataDir"
} else {
    Write-Host "uninstalled nia-agent (config/secrets/spool/logs kept at `$env:ProgramData\NiaAgent)"
}

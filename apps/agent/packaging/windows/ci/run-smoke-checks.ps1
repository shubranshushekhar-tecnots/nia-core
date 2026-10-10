# Lean smoke test for the Nia Core Agent Windows installer + Electron
# desktop shell. Invoked by .github/workflows/agent-windows-smoke.yml:
#   run-smoke-checks.ps1 -SetupExePath <path to NiaCoreAgent-Setup-*.exe>
#
# Unlike run-checks.ps1 (checks A-I, SQL Server-backed functional tests of
# pairing/sync), this script never touches SQL Server or the platform/
# Planometry fakes -- it only exercises the installer/service/Electron
# shell plumbing itself, kept intentionally small so it runs in minutes,
# not the better part of an hour.
#
# Design: every check is independent and continue-on-failure, same as
# run-checks.ps1 -- one bad check must never hide the results of the
# rest. Must run as Administrator (GitHub's windows-latest runner already
# is).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SetupExePath,
    [string]$ArtifactsDir = (Join-Path (Get-Location).Path "ci-artifacts")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

$script:Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param([string]$Check, [bool]$Pass, [string]$Detail = "")
    $script:Results.Add([pscustomobject]@{ Check = $Check; Pass = $Pass; Detail = $Detail })
    $status = if ($Pass) { "PASS" } else { "FAIL" }
    Write-Host "[$status] $Check $(if ($Detail) { "- $Detail" })"
}

function Invoke-Section {
    param([string]$Name, [scriptblock]$Body)
    Write-Host ""
    Write-Host "==================== $Name ===================="
    try {
        & $Body
    } catch {
        Add-Result -Check $Name -Pass $false -Detail "unhandled exception: $($_.Exception.Message)"
        Write-Host $_.ScriptStackTrace
    }
}

$ProgramFiles64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$InstallDir = Join-Path $ProgramFiles64 "NiaAgent"
$DataDir = Join-Path $env:ProgramData "NiaAgent"
$LocalApiDir = Join-Path $DataDir "local-api"
$ElectronExe = Join-Path $InstallDir "NiaAgentDesktop\Nia Agent.exe"
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("CommonStartMenu")) "Programs\Nia Core Agent"
$ServiceName = "nia-agent"
$ElectronProcessName = "Nia Agent"

# ============================================================================
# Helpers
# ============================================================================

function Get-ServiceStateViaScQuery {
    $out = & sc.exe query $ServiceName 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = $out | Where-Object { $_ -match "STATE" } | Select-Object -First 1
    if ($line -match "\b(\w+)\s*$") { return $Matches[1] }
    return $null
}

function Wait-ServiceRunning {
    param([int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ServiceStateViaScQuery) -eq "RUNNING") { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# Waits for at least one "Nia Agent.exe" process to appear, polling
# instead of a single immediate check -- Electron's own startup
# (window creation, GPU process spawn) is not instant.
function Wait-ElectronProcess {
    param([int]$TimeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $procs = Get-Process -Name $ElectronProcessName -ErrorAction SilentlyContinue
        if ($procs) { return $procs }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Stop-ElectronProcessTree {
    taskkill /F /IM "Nia Agent.exe" /T 2>$null | Out-Null
}

function Wait-ElectronProcessGone {
    param([int]$TimeoutSec = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Name $ElectronProcessName -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return -not (Get-Process -Name $ElectronProcessName -ErrorAction SilentlyContinue)
}

# Copies install.ps1's own log + the agent/WinSW runtime logs out of the
# real %ProgramData%\NiaAgent so they survive the ephemeral runner being
# torn down -- these live outside the uploaded $ArtifactsDir otherwise.
function Copy-Diagnostics {
    param([string]$Tag)
    $candidates = @(Join-Path $DataDir "install.log")
    $realLogsDir = Join-Path $DataDir "logs"
    if (Test-Path $realLogsDir) {
        $candidates += (Get-ChildItem -Path $realLogsDir -File -ErrorAction SilentlyContinue).FullName
    }
    $candidates += (Join-Path $env:TEMP "nia-agent-install.log")
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path -PathType Leaf)) {
            $destName = "$Tag.$([System.IO.Path]::GetFileName($path))"
            try { Copy-Item -Path $path -Destination (Join-Path $ArtifactsDir $destName) -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

# ============================================================================
# CHECK 1: silent install succeeds
# ============================================================================

Invoke-Section "CHECK 1: silent install" {
    $proc = Start-Process -FilePath $SetupExePath -ArgumentList "/S" -Wait -PassThru
    Copy-Diagnostics -Tag "install"
    Add-Result -Check "CHECK 1: silent install exits 0" -Pass ($proc.ExitCode -eq 0) -Detail "exit code: $($proc.ExitCode)"
}

# ============================================================================
# CHECK 2: service installed and running
# ============================================================================

Invoke-Section "CHECK 2: service installed and running" {
    $running = Wait-ServiceRunning -TimeoutSec 60
    Add-Result -Check "CHECK 2: nia-agent service reaches RUNNING" -Pass $running -Detail "last state: $(Get-ServiceStateViaScQuery)"
}

# ============================================================================
# CHECK 3: local API port file + token exist, GET /status returns 200
# ============================================================================

Invoke-Section "CHECK 3: local API /status" {
    $portFile = Join-Path $LocalApiDir "port.json"
    $tokenFile = Join-Path $LocalApiDir "token"
    $portFileExists = Test-Path $portFile -PathType Leaf
    Add-Result -Check "CHECK 3a: local-api\port.json exists" -Pass $portFileExists

    if ($portFileExists -and (Test-Path $tokenFile -PathType Leaf)) {
        $port = (Get-Content $portFile -Raw | ConvertFrom-Json).port
        $token = (Get-Content $tokenFile -Raw).Trim()
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/status" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 10
            Add-Result -Check "CHECK 3b: GET /status returns 200" -Pass ($resp.StatusCode -eq 200) -Detail "status: $($resp.StatusCode)"
        } catch {
            Add-Result -Check "CHECK 3b: GET /status returns 200" -Pass $false -Detail $_.Exception.Message
        }
    } else {
        Add-Result -Check "CHECK 3b: GET /status returns 200" -Pass $false -Detail "port.json or token missing"
    }
}

# ============================================================================
# CHECK 4: every Start Menu .lnk target exists and is never Sysnative
# ============================================================================

Invoke-Section "CHECK 4: Start Menu shortcut targets" {
    $lnks = Get-ChildItem -Path $StartMenuDir -Filter "*.lnk" -ErrorAction SilentlyContinue
    if (-not $lnks) {
        Add-Result -Check "CHECK 4: Start Menu shortcuts exist" -Pass $false -Detail "no .lnk files found under $StartMenuDir"
    } else {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($lnk in $lnks) {
            $sc = $shell.CreateShortcut($lnk.FullName)
            $target = $sc.TargetPath
            $targetOk = $target -and (Test-Path $target)
            $noSysnative = ($target -notmatch "Sysnative") -and ($sc.Arguments -notmatch "Sysnative")
            Add-Result -Check "CHECK 4: $($lnk.Name) target resolves" -Pass $targetOk -Detail "target: $target"
            Add-Result -Check "CHECK 4: $($lnk.Name) has no Sysnative path" -Pass $noSysnative -Detail "target: $target args: $($sc.Arguments)"
        }
    }
}

# ============================================================================
# CHECK 5: Electron relaunch -- start/kill 3 times, each start must succeed
# ============================================================================

Invoke-Section "CHECK 5: Electron relaunch (start/kill x3)" {
    for ($i = 1; $i -le 3; $i++) {
        Start-Process -FilePath $ElectronExe
        $procs = Wait-ElectronProcess -TimeoutSec 20
        Add-Result -Check "CHECK 5.${i}: Nia Agent.exe starts" -Pass ([bool]$procs)
        Stop-ElectronProcessTree
        $gone = Wait-ElectronProcessGone -TimeoutSec 15
        Add-Result -Check "CHECK 5.${i}: Nia Agent.exe stops" -Pass $gone
    }
}

# ============================================================================
# CHECK 6: single instance -- starting twice leaves exactly one process tree
# ============================================================================

Invoke-Section "CHECK 6: single instance" {
    Start-Process -FilePath $ElectronExe
    $first = Wait-ElectronProcess -TimeoutSec 20
    Add-Result -Check "CHECK 6: first launch starts" -Pass ([bool]$first)

    Start-Process -FilePath $ElectronExe
    Start-Sleep -Seconds 3

    $procs = Get-CimInstance Win32_Process -Filter "Name='Nia Agent.exe'" -ErrorAction SilentlyContinue
    if (-not $procs) {
        Add-Result -Check "CHECK 6: exactly one process tree is running" -Pass $false -Detail "no Nia Agent.exe processes found"
    } else {
        $pids = @($procs | ForEach-Object { $_.ProcessId })
        $roots = @($procs | Where-Object { $pids -notcontains $_.ParentProcessId })
        Add-Result -Check "CHECK 6: exactly one process tree is running" -Pass ($roots.Count -eq 1) -Detail "root count: $($roots.Count), total processes: $($pids.Count)"
    }

    Stop-ElectronProcessTree
    Wait-ElectronProcessGone -TimeoutSec 15 | Out-Null
}

# ============================================================================
# CHECK 7: upgrade path -- reinstalling while the app is running succeeds
# ============================================================================

Invoke-Section "CHECK 7: upgrade while the app is running" {
    Start-Process -FilePath $ElectronExe
    Wait-ElectronProcess -TimeoutSec 20 | Out-Null

    $proc = Start-Process -FilePath $SetupExePath -ArgumentList "/S" -Wait -PassThru
    Copy-Diagnostics -Tag "upgrade"
    Add-Result -Check "CHECK 7a: reinstall over a running app exits 0" -Pass ($proc.ExitCode -eq 0) -Detail "exit code: $($proc.ExitCode)"

    $running = Wait-ServiceRunning -TimeoutSec 60
    Add-Result -Check "CHECK 7b: service still reaches RUNNING after upgrade" -Pass $running

    Stop-ElectronProcessTree
    Wait-ElectronProcessGone -TimeoutSec 15 | Out-Null
}

# ============================================================================
# CHECK 8: silent uninstall removes the service, app folder, and shortcuts
# (user data under %ProgramData%\NiaAgent is expected to remain -- the
# default for a silent uninstall, matching uninstall.ps1 / installer.nsi).
# ============================================================================

Invoke-Section "CHECK 8: silent uninstall" {
    $uninstExe = Join-Path $InstallDir "Uninstall.exe"
    $proc = Start-Process -FilePath $uninstExe -ArgumentList "/S" -Wait -PassThru
    Copy-Diagnostics -Tag "uninstall"
    Add-Result -Check "CHECK 8a: silent uninstall exits 0" -Pass ($proc.ExitCode -eq 0) -Detail "exit code: $($proc.ExitCode)"

    Start-Sleep -Seconds 2
    $serviceGone = -not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    Add-Result -Check "CHECK 8b: nia-agent service is gone" -Pass $serviceGone

    $installDirGone = -not (Test-Path $InstallDir)
    Add-Result -Check "CHECK 8c: install folder is gone" -Pass $installDirGone

    $shortcutsGone = -not (Test-Path $StartMenuDir)
    Add-Result -Check "CHECK 8d: Start Menu shortcuts are gone" -Pass $shortcutsGone

    $dataKept = Test-Path $DataDir
    Add-Result -Check "CHECK 8e: user data under ProgramData is kept (default silent behavior)" -Pass $dataKept
}

# ============================================================================
# Report
# ============================================================================

$resultsPath = Join-Path $ArtifactsDir "results.csv"
$script:Results | Export-Csv -Path $resultsPath -NoTypeInformation
$script:Results | Format-Table -AutoSize | Out-String | Write-Host

$failures = $script:Results | Where-Object { -not $_.Pass }
if ($failures) {
    Write-Host ""
    Write-Host "FAILED CHECKS:"
    $failures | ForEach-Object { Write-Host "  - $($_.Check): $($_.Detail)" }
    exit 1
}

Write-Host ""
Write-Host "All checks passed."
exit 0

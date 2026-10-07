# Master test script for the Nia Core Agent Windows installer/guided-setup
# (docs/plans/release-prep.md-style verification — checks A through I).
# Invoked by .github/workflows/windows-installer.yml's `test` job:
#   run-checks.ps1 -PackagesDir <dir with *.exe/*.zip> -RepoDir <repo snapshot>
#
# Design: every assertion is independent and continue-on-failure — one bad
# check must never abort the rest, so the final report always covers every
# check even when several fail. Each assertion is recorded via Add-Result
# into $script:Results and the full table is written to
# $ArtifactsDir\results.csv / results.txt at the end, plus every CLI
# invocation's stdout/stderr under $ArtifactsDir\logs\ — all uploaded by the
# workflow's "Upload results" step (`if: always()`).
#
# Must run as Administrator (GitHub's windows-latest runner already is).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagesDir,
    [Parameter(Mandatory = $true)][string]$RepoDir,
    [string]$ArtifactsDir = (Join-Path (Get-Location).Path "ci-artifacts")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ============================================================================
# Globals
# ============================================================================

$LogsDir = Join-Path $ArtifactsDir "logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$script:Results = New-Object System.Collections.Generic.List[object]
$script:LogCounter = 0

$SetupExe = Get-ChildItem -Path $PackagesDir -Filter "NiaCoreAgent-Setup-*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$ZipBundle = Get-ChildItem -Path $PackagesDir -Filter "nia-agent-windows-*.zip" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SetupExe) { throw "no NiaCoreAgent-Setup-*.exe found under $PackagesDir" }
if (-not $ZipBundle) { throw "no nia-agent-windows-*.zip found under $PackagesDir" }
Write-Host "setup exe:  $($SetupExe.FullName)"
Write-Host "zip bundle: $($ZipBundle.FullName)"

$script:SecretsToRedact = New-Object System.Collections.Generic.List[string]
function Add-SecretToRedact {
    param([string]$Secret)
    if ($Secret) { $script:SecretsToRedact.Add($Secret) }
}

$SqlInstanceName = $env:SQL_INSTANCE_NAME
$SqlSaPassword = $env:SQL_SA_PASSWORD
if (-not $SqlInstanceName) { throw "SQL_INSTANCE_NAME env var not set — install-sql-express.ps1 must run first" }
if (-not $SqlSaPassword) { throw "SQL_SA_PASSWORD env var not set — install-sql-express.ps1 must run first" }
Write-Host "::add-mask::$SqlSaPassword"
Add-SecretToRedact $SqlSaPassword
$SqlServiceName = "MSSQL`$$SqlInstanceName"

$ProgramFiles64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$InstallDir = Join-Path $ProgramFiles64 "NiaAgent"
$LegacyX86Dir = Join-Path ${env:ProgramFiles(x86)} "NiaAgent"
$RealDataDir = Join-Path $env:ProgramData "NiaAgent"
$ServiceAccount = "NT SERVICE\nia-agent"
$AdministratorsSidString = "S-1-5-32-544"
$UninstKeyPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NiaCoreAgent"
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("CommonStartMenu")) "Programs\Nia Core Agent"

$AgentDir = Join-Path $RepoDir "apps\agent\src\testing"
$PnpmCmd = (Get-Command pnpm -ErrorAction SilentlyContinue)
$PnpmPath = if ($PnpmCmd) { $PnpmCmd.Source } else { "pnpm.cmd" }

$FakePlatformPort = 4466
$FakePlanometryPushPort = 4455
$FakePlanometryControlPort = 4456
$FakePlatformUrl = "http://127.0.0.1:$FakePlatformPort"
$FakePlanometryControlUrl = "http://127.0.0.1:$FakePlanometryControlPort"

$TestDbName = "NiaAgentTestDB"
$ReadonlyLogin = "nia_agent_ro"
$ReadonlyLoginPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 28 | ForEach-Object { [char]$_ })
Write-Host "::add-mask::$ReadonlyLoginPassword"
Add-SecretToRedact $ReadonlyLoginPassword
$WrongPassword = "Wr0ng-Password-Not-The-Real-One!"
Add-SecretToRedact $WrongPassword

$script:FakePlatformProc = $null
$script:FakePlanometryProc = $null

# ============================================================================
# Generic helpers
# ============================================================================

function Add-Result {
    param([string]$Check, [bool]$Pass, [string]$Detail = "")
    $script:Results.Add([pscustomobject]@{ Check = $Check; Pass = $Pass; Detail = $Detail })
    $status = if ($Pass) { "PASS" } else { "FAIL" }
    Write-Host "[$status] $Check $(if ($Detail) { "- $Detail" })"
}

function Protect-LogText {
    param([string]$Text)
    if (-not $Text) { return $Text }
    foreach ($secret in $script:SecretsToRedact) {
        if ($secret) { $Text = $Text.Replace($secret, "***REDACTED***") }
    }
    return $Text
}

# Copies install.ps1's own step-by-step log (and the WinSW/agent runtime
# logs, if present) out of the real %ProgramData%\NiaAgent into the CI
# artifact, tagged per-check. Run #3 showed the installer/uninstaller
# process genuinely hanging for its entire -TimeoutSec (not just running
# slowly), with install.ps1's own bounded-loop logic giving no indication
# why -- these files are the only way to see which step it actually got
# stuck on, and they live in $RealDataDir which is NOT otherwise part of
# the uploaded $LogsDir artifact, so they'd be lost when the ephemeral
# runner is torn down unless copied out here. Must never throw: it has to
# be safe to call after every install/uninstall attempt regardless of
# whether the process succeeded, failed, or was killed on timeout (in the
# timeout case the files may not exist yet at all, or may be mid-write).
function Copy-InstallDiagnostics {
    param([string]$Tag)
    $candidates = @(Join-Path $RealDataDir "install.log")
    $realLogsDir = Join-Path $RealDataDir "logs"
    if (Test-Path $realLogsDir) {
        $candidates += (Get-ChildItem -Path $realLogsDir -File -ErrorAction SilentlyContinue).FullName
    }
    # install.ps1 falls back to %TEMP%\nia-agent-install.log if $RealDataDir
    # itself couldn't be created/written -- capture that too, just in case.
    $candidates += (Join-Path $env:TEMP "nia-agent-install.log")
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path -PathType Leaf)) {
            $destName = "$Tag.$([System.IO.Path]::GetFileName($path))"
            try {
                Copy-Item -Path $path -Destination (Join-Path $LogsDir $destName) -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
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

# Runs a process to completion, capturing stdout/stderr (async, deadlock-
# free) and optionally feeding one line of stdin. Env vars listed in
# -EnvOverrides are set only on the child (ProcessStartInfo.EnvironmentVariables
# is pre-populated from this process's own environment; overrides apply on
# top of that; the calling shell's own environment is never touched).
function Invoke-Proc {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [hashtable]$EnvOverrides = @{},
        [string]$StdIn,
        [int]$TimeoutSec = 120,
        [string]$LogName
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    foreach ($a in $Arguments) { [void]$psi.ArgumentList.Add($a) }
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    foreach ($k in $EnvOverrides.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvOverrides[$k] }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $outSb = New-Object System.Text.StringBuilder
    $errSb = New-Object System.Text.StringBuilder
    $outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
        if ($null -ne $Event.SourceEventArgs.Data) { [void]$Event.MessageData.AppendLine($Event.SourceEventArgs.Data) }
    } -MessageData $outSb
    $errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
        if ($null -ne $Event.SourceEventArgs.Data) { [void]$Event.MessageData.AppendLine($Event.SourceEventArgs.Data) }
    } -MessageData $errSb
    try {
        [void]$proc.Start()
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        if ($StdIn) { $proc.StandardInput.Write($StdIn) }
        $proc.StandardInput.Close()
        $finished = $proc.WaitForExit($TimeoutSec * 1000)
        if (-not $finished) {
            try { $proc.Kill($true) } catch {}
        }
    } finally {
        Start-Sleep -Milliseconds 100  # let the last async output events land
        Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue
        Remove-Job -Name $outEvent.Name -ErrorAction SilentlyContinue -Force
        Remove-Job -Name $errEvent.Name -ErrorAction SilentlyContinue -Force
    }
    $exitCode = if ($finished) { $proc.ExitCode } else { -1 }
    $stdout = $outSb.ToString()
    $stderr = $errSb.ToString()

    if ($LogName) {
        $script:LogCounter += 1
        $tag = "{0:D3}-{1}" -f $script:LogCounter, ($LogName -replace '[^A-Za-z0-9_.-]', '_')
        Set-Content -Path (Join-Path $LogsDir "$tag.cmd.txt") -Value (Protect-LogText "$FilePath $($Arguments -join ' ')")
        Set-Content -Path (Join-Path $LogsDir "$tag.out.log") -Value (Protect-LogText $stdout)
        Set-Content -Path (Join-Path $LogsDir "$tag.err.log") -Value (Protect-LogText $stderr)
    }

    return [pscustomobject]@{ ExitCode = $exitCode; StdOut = $stdout; StdErr = $stderr; TimedOut = -not $finished }
}

# pnpm ships as a .cmd shim on Windows — never runnable directly via
# ProcessStartInfo without UseShellExecute, so always go through cmd.exe /c.
function Invoke-Pnpm {
    param([string[]]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSec = 60, [string]$LogName)
    $cmdArgs = @("/c", $PnpmPath) + $Arguments
    return Invoke-Proc -FilePath "cmd.exe" -Arguments $cmdArgs -WorkingDirectory $WorkingDirectory -TimeoutSec $TimeoutSec -LogName $LogName
}

function New-ThrowawayHome {
    param([string]$Suffix)
    $dir = Join-Path $env:TEMP "nia-agent-home-$Suffix-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function New-AnswersFile {
    param([hashtable]$Answers, [string]$Path)
    $lines = foreach ($k in $Answers.Keys) { "$k=$($Answers[$k])" }
    Set-Content -Path $Path -Value $lines -Encoding utf8
}

function New-PairingCode {
    # POST /control/pairing-codes -> {pairingCodeId, code, composite}
    $resp = Invoke-RestMethod -Method Post -Uri "$FakePlatformUrl/control/pairing-codes" -Body "{}" -ContentType "application/json"
    return $resp
}

function Get-FakeAgentInfo {
    param([string]$AgentId)
    return Invoke-RestMethod -Method Get -Uri "$FakePlatformUrl/control/agents/$AgentId"
}

function Invoke-NiaAgent {
    param(
        [string[]]$Arguments,
        [string]$HomeDir,
        [string]$StdIn,
        [int]$TimeoutSec = 60,
        [string]$LogName
    )
    $envOverrides = @{}
    if ($HomeDir) { $envOverrides["NIA_AGENT_HOME"] = $HomeDir }
    return Invoke-Proc -FilePath (Join-Path $InstallDir "nia-agent.exe") -Arguments $Arguments -EnvOverrides $envOverrides -StdIn $StdIn -TimeoutSec $TimeoutSec -LogName $LogName
}

function Wait-HttpReady {
    param([string]$Url, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            # -SkipHttpErrorCheck: readiness only needs the server to respond at
            # all — a 404 for a deliberately nonexistent id/table still proves
            # the server is up and routing requests, so it must not be treated
            # as "not ready" the way Invoke-WebRequest's default non-2xx-throws
            # behavior would.
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -SkipHttpErrorCheck | Out-Null
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Start-FakeServers {
    Write-Host "starting fake platform server (port $FakePlatformPort)..."
    $script:FakePlatformProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/c", $PnpmPath, "--filter", "@nia/agent", "run", "manual:platform") `
        -WorkingDirectory $RepoDir `
        -RedirectStandardOutput (Join-Path $LogsDir "fake-platform.out.log") `
        -RedirectStandardError (Join-Path $LogsDir "fake-platform.err.log") `
        -NoNewWindow -PassThru
    Write-Host "starting fake planometry server (push $FakePlanometryPushPort / control $FakePlanometryControlPort)..."
    $script:FakePlanometryProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/c", $PnpmPath, "--filter", "@nia/agent", "run", "manual:planometry") `
        -WorkingDirectory $RepoDir `
        -RedirectStandardOutput (Join-Path $LogsDir "fake-planometry.out.log") `
        -RedirectStandardError (Join-Path $LogsDir "fake-planometry.err.log") `
        -NoNewWindow -PassThru

    $platformReady = Wait-HttpReady -Url "$FakePlatformUrl/control/agents/nonexistent" -TimeoutSec 30
    $planometryReady = Wait-HttpReady -Url "$FakePlanometryControlUrl/rows?tableId=nonexistent" -TimeoutSec 30
    Add-Result -Check "setup.fake-platform-ready" -Pass $platformReady
    Add-Result -Check "setup.fake-planometry-ready" -Pass $planometryReady
}

function Stop-FakeServers {
    foreach ($p in @($script:FakePlatformProc, $script:FakePlanometryProc)) {
        if ($p -and -not $p.HasExited) {
            try {
                Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue | ForEach-Object {
                    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                }
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
}

# ---------------------------------------------------------------------------
# SQL Server Express helpers
# ---------------------------------------------------------------------------

function Get-SqlInstanceRegistryId {
    $namesKey = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL"
    return (Get-ItemProperty -Path $namesKey -Name $SqlInstanceName -ErrorAction Stop).$SqlInstanceName
}

function Restart-SqlInstanceAndWait {
    param([int]$TimeoutSec = 90)
    try {
        Restart-Service -Name $SqlServiceName -Force -ErrorAction Stop
    } catch {
        Write-Host "Restart-Service failed for $SqlServiceName : $($_.Exception.Message)"
        $errorLogs = Get-ChildItem -Path "C:\Program Files\Microsoft SQL Server\*\MSSQL\Log\ERRORLOG" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
        if ($errorLogs) {
            Write-Host "---- Diagnostic: SQL Server ERRORLOG tail ----"
            Get-Content -Path $errorLogs[0].FullName -Tail 60 -ErrorAction SilentlyContinue | Write-Host
        }
        return $false
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $SqlServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq "Running") { Start-Sleep -Seconds 3; return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Set-SqlTcp {
    param([bool]$Enabled, [int]$Port = 0)
    $instanceId = Get-SqlInstanceRegistryId
    $netLibKey = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer\SuperSocketNetLib"
    $tcpKey = "$netLibKey\Tcp"
    $ipAllKey = "$tcpKey\IPAll"
    New-Item -Path $tcpKey -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path $tcpKey -Name "Enabled" -Value ([int]$Enabled) -Type DWord
    # SNI's TDSSNIClient reads a "TcpKeepAlive" DWORD directly under the Tcp
    # key on every startup where tcp is in ProtocolList, not just when first
    # configuring it through SQL Server Configuration Manager (which writes
    # this value as a side effect of its UI, unlike a bare registry toggle).
    # Missing it fails SQL Server startup outright with "TDSSNIClient
    # initialization failed with error 0x2, status code 0x8/0x1 ... Unable to
    # retrieve 'TcpKeepAlive' registry setting" (0x2 = ERROR_FILE_NOT_FOUND)
    # -> "Could not start the network library" -> service fails to start.
    # Confirmed by reproducing exactly this failure in CI before adding this.
    Set-ItemProperty -Path $tcpKey -Name "TcpKeepAlive" -Value 30000 -Type DWord
    if ($Enabled) {
        New-Item -Path $ipAllKey -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $ipAllKey -Name "TcpPort" -Value "$Port" -Type String
        Set-ItemProperty -Path $ipAllKey -Name "TcpDynamicPorts" -Value "" -Type String
    } else {
        if (Test-Path $ipAllKey) {
            Set-ItemProperty -Path $ipAllKey -Name "TcpPort" -Value "" -Type String -ErrorAction SilentlyContinue
            Set-ItemProperty -Path $ipAllKey -Name "TcpDynamicPorts" -Value "" -Type String -ErrorAction SilentlyContinue
        }
    }

    # The Tcp\Enabled DWORD alone is not always sufficient — SQL Server also
    # consults the sibling ProtocolList value (comma-separated protocol codes,
    # e.g. "sm,tcp") directly under SuperSocketNetLib at startup. Keep it in
    # sync so a toggle here reliably takes effect after a service restart.
    $existingList = (Get-ItemProperty -Path $netLibKey -Name "ProtocolList" -ErrorAction SilentlyContinue).ProtocolList
    $protocols = if ($existingList) { @($existingList -split "," | Where-Object { $_ }) } else { @("sm") }
    if ($Enabled) {
        if ($protocols -notcontains "tcp") { $protocols += "tcp" }
    } else {
        $protocols = $protocols | Where-Object { $_ -ne "tcp" }
    }
    Set-ItemProperty -Path $netLibKey -Name "ProtocolList" -Value ($protocols -join ",") -Type String
}

function Set-SqlLoginMode {
    param([int]$Mode)  # 1 = Windows-only, 2 = Mixed
    $instanceId = Get-SqlInstanceRegistryId
    $key = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instanceId\MSSQLServer"
    Set-ItemProperty -Path $key -Name "LoginMode" -Value $Mode -Type DWord
}

function Invoke-Sqlcmd2 {
    param([string]$Query, [string]$InputFile, [int]$TimeoutSec = 60, [string]$LogName)
    $sqlArgs = @("-S", ".\$SqlInstanceName", "-U", "sa", "-P", $SqlSaPassword, "-b")
    if ($InputFile) { $sqlArgs += @("-i", $InputFile) } else { $sqlArgs += @("-Q", $Query) }
    return Invoke-Proc -FilePath "sqlcmd.exe" -Arguments $sqlArgs -TimeoutSec $TimeoutSec -LogName $LogName
}

# ============================================================================
# Shared invariant checks (checks A / E / F / G / H all re-verify these)
# ============================================================================

function Test-FreshInstallInvariants {
    param([string]$Prefix)

    $svc = Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue | Select-Object -First 1
    Add-Result -Check "$Prefix.service-exists" -Pass ([bool]$svc)
    if ($svc) {
        Add-Result -Check "$Prefix.service-running" -Pass ($svc.Status -eq "Running") -Detail "status=$($svc.Status)"
        Add-Result -Check "$Prefix.service-autostart" -Pass ($svc.StartType -eq "Automatic") -Detail "startType=$($svc.StartType)"
    }

    $qc = & sc.exe qc nia-agent 2>&1
    $startName = ($qc | Where-Object { $_ -match "SERVICE_START_NAME" } | Select-Object -First 1)
    # $startName is $null when the service doesn't exist (e.g. install failed
    # before registering it) -- but it's $null via an empty Where-Object/
    # Select-Object pipeline result, not a literal $null, and -match on that
    # particular flavor of "nothing" returns an empty array rather than
    # $false, which then fails to bind to Add-Result's [bool]$Pass parameter
    # ("Cannot convert value System.Object[] to type System.Boolean").
    # Confirmed by local repro. Force it back to a real boolean.
    Add-Result -Check "$Prefix.service-account" -Pass ([bool]($startName -match [regex]::Escape($ServiceAccount))) -Detail "$startName"

    Add-Result -Check "$Prefix.install-dir" -Pass (Test-Path (Join-Path $InstallDir "nia-agent.exe")) -Detail $InstallDir
    Add-Result -Check "$Prefix.legacy-x86-dir-absent" -Pass (-not (Test-Path $LegacyX86Dir))

    $dataAcl = Get-Acl $RealDataDir -ErrorAction SilentlyContinue
    if ($dataAcl) {
        $rules = $dataAcl.Access
        $identities = $rules | ForEach-Object { $_.IdentityReference.Value }
        $administratorsSid = (New-Object Security.Principal.SecurityIdentifier($AdministratorsSidString)).Translate([Security.Principal.NTAccount]).Value
        $hasServiceAccount = $identities -contains $ServiceAccount
        $hasAdmins = $identities -contains $administratorsSid
        $inheritanceDisabled = -not $dataAcl.AreAccessRulesProtected -eq $false  # AreAccessRulesProtected should be $true
        Add-Result -Check "$Prefix.data-dir-acl-restricted" -Pass ($dataAcl.AreAccessRulesProtected -and $hasServiceAccount -and $hasAdmins) `
            -Detail "protected=$($dataAcl.AreAccessRulesProtected) identities=$($identities -join ',')"
    } else {
        Add-Result -Check "$Prefix.data-dir-acl-restricted" -Pass $false -Detail "$RealDataDir not found"
    }

    $uninstKey = Get-ItemProperty -Path $UninstKeyPath -ErrorAction SilentlyContinue
    Add-Result -Check "$Prefix.uninstall-registry-entry" -Pass ([bool]$uninstKey) -Detail $(if ($uninstKey) { $uninstKey.DisplayName } else { "missing" })

    Add-Result -Check "$Prefix.start-menu-shortcuts" -Pass (
        (Test-Path (Join-Path $StartMenuDir "Nia Core Agent Setup.lnk")) -and
        (Test-Path (Join-Path $StartMenuDir "Nia Core Agent Status.lnk"))
    )

    $versionResult = Invoke-NiaAgent -Arguments @("version") -LogName "$Prefix-version"
    Add-Result -Check "$Prefix.cli-version" -Pass ($versionResult.ExitCode -eq 0) -Detail $versionResult.StdOut.Trim()

    $statusResult = Invoke-NiaAgent -Arguments @("status") -LogName "$Prefix-status"
    Add-Result -Check "$Prefix.cli-status" -Pass ($statusResult.ExitCode -eq 0) -Detail ($statusResult.StdOut -split "`n" | Select-Object -First 1)
}

# ============================================================================
# CHECK A — fresh install
# ============================================================================

function Invoke-CheckA {
    Invoke-Section "CHECK A: fresh install" {
        $result = Invoke-Proc -FilePath $SetupExe.FullName -Arguments @("/S") -TimeoutSec 420 -LogName "A-install"
        Copy-InstallDiagnostics -Tag "A-install"
        Add-Result -Check "A.installer-exit-code" -Pass ($result.ExitCode -eq 0) -Detail "exit=$($result.ExitCode)"
        Test-FreshInstallInvariants -Prefix "A"
    }
}

# ============================================================================
# CHECK B — guided setup / pairing variations (throwaway homes)
# ============================================================================

function Invoke-CheckB1 {
    Invoke-Section "CHECK B1: pairing via full pasted command" {
        $homeDir = New-ThrowawayHome -Suffix "b1"
        $code = New-PairingCode
        $answers = @{
            pairing      = "nia-agent pair --code $($code.composite) --url $FakePlatformUrl"
            dbaDatabases = "master"
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 60 -LogName "B1-setup"
        Add-Result -Check "B1.paired" -Pass ($result.StdOut -match "Paired as agent") -Detail ($result.StdOut -split "`n" | Where-Object { $_ -match "Paired" } | Select-Object -First 1)
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue
    }
}

function Invoke-CheckB2 {
    Invoke-Section "CHECK B2: pairing via bare code + address" {
        $homeDir = New-ThrowawayHome -Suffix "b2"
        $code = New-PairingCode
        $answers = @{
            pairing      = $code.composite
            platformUrl  = $FakePlatformUrl
            dbaDatabases = "master"
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 60 -LogName "B2-setup"
        Add-Result -Check "B2.paired" -Pass ($result.StdOut -match "Paired as agent") -Detail ($result.StdOut -split "`n" | Where-Object { $_ -match "Paired" } | Select-Object -First 1)
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue
    }
}

function Invoke-CheckB3 {
    Invoke-Section "CHECK B3: expired/wrong pairing code gives a plain message" {
        $homeDir = New-ThrowawayHome -Suffix "b3"
        $answers = @{
            pairing = "00000000-0000-0000-0000-000000000000.bogus-code-never-issued"
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 30 -LogName "B3-setup"
        Add-Result -Check "B3.plain-failure-message" -Pass ($result.StdOut -match "Pairing failed: pairing code is invalid") -Detail ($result.StdOut -split "`n" | Where-Object { $_ -match "Pairing failed" } | Select-Object -First 1)
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# Test database setup (real SQL Server Express, via sqlcmd as sa — never via TCP)
# ============================================================================

function Initialize-TestDatabase {
    Invoke-Section "setup: create real test database + seed rows" {
        $createDbResult = Invoke-Sqlcmd2 -Query "IF DB_ID('$TestDbName') IS NULL CREATE DATABASE [$TestDbName];" -LogName "db-create"
        Add-Result -Check "setup.create-test-database" -Pass ($createDbResult.ExitCode -eq 0) -Detail $createDbResult.StdErr.Trim()

        $createTableSql = @"
USE [$TestDbName];
IF OBJECT_ID('dbo.Widgets') IS NULL
BEGIN
  CREATE TABLE dbo.Widgets (Id INT PRIMARY KEY, Name NVARCHAR(100) NOT NULL, UpdatedAt DATETIME2 NOT NULL);
  INSERT INTO dbo.Widgets (Id, Name, UpdatedAt) VALUES
    (1, N'Widget One', SYSUTCDATETIME()),
    (2, N'Widget Two', SYSUTCDATETIME()),
    (3, N'Widget Three', SYSUTCDATETIME());
END
"@
        $sqlPath = Join-Path $LogsDir "create-widgets-table.sql"
        Set-Content -Path $sqlPath -Value $createTableSql
        $createTableResult = Invoke-Sqlcmd2 -InputFile $sqlPath -LogName "db-create-table"
        Add-Result -Check "setup.create-test-table" -Pass ($createTableResult.ExitCode -eq 0) -Detail $createTableResult.StdErr.Trim()
    }
}

# ============================================================================
# CHECK C — database questions against real SQL Server Express
# ============================================================================

function Invoke-CheckC1-TcpDisabled {
    Invoke-Section "CHECK C1: TCP/IP disabled is explained with remediation steps" {
        $homeDir = New-ThrowawayHome -Suffix "c1"
        $code = New-PairingCode
        # sqlInstanceChoice=1 actually selects the (sole) detected instance, so
        # the code path at setupCommand.ts's `if (!picked.tcpEnabled)` fires the
        # remediation message — leaving it blank would skip straight past it.
        $answers = @{
            pairing           = $code.composite
            platformUrl       = $FakePlatformUrl
            sqlInstanceChoice = "1"
            dbaDatabases      = "master"
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 60 -LogName "C1-setup"
        $foundInstance = ($result.StdOut -match [regex]::Escape($SqlInstanceName)) -and ($result.StdOut -match "TCP/IP disabled")
        $remediation = ($result.StdOut -match "TCP/IP is disabled for") -and ($result.StdOut -match "SQL Server Configuration Manager -> SQL Server Network Configuration")
        Add-Result -Check "C1.tcp-disabled-detected" -Pass $foundInstance
        Add-Result -Check "C1.tcp-disabled-remediation-shown" -Pass $remediation
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue
    }
}

function Enable-SqlTcpForTesting {
    Invoke-Section "setup: enable SQL Server TCP/IP for subsequent checks" {
        Set-SqlTcp -Enabled $true -Port 14330
        $restarted = Restart-SqlInstanceAndWait -TimeoutSec 90
        Add-Result -Check "setup.sql-tcp-enabled-and-restarted" -Pass $restarted
        $script:SqlTcpPort = 14330
    }
}

function Invoke-CheckC2-DbaScript {
    Invoke-Section "CHECK C2: DBA readonly script runs cleanly, creates a working readonly login" {
        $scriptPath = Join-Path $LogsDir "nia-readonly-setup.sql"
        $genResult = Invoke-NiaAgent -Arguments @("sql", "readonly", "--login", $ReadonlyLogin, "--databases", $TestDbName, "--out", $scriptPath) -TimeoutSec 30 -LogName "C2-generate-script"
        Add-Result -Check "C2.script-generated" -Pass (($genResult.ExitCode -eq 0) -and (Test-Path $scriptPath))

        $rawScript = Get-Content -Path $scriptPath -Raw
        Add-Result -Check "C2.script-has-placeholder-password" -Pass ($rawScript -match [regex]::Escape("<CHANGE_ME_STRONG_PASSWORD>"))
        $realScript = $rawScript -replace [regex]::Escape("<CHANGE_ME_STRONG_PASSWORD>"), $ReadonlyLoginPassword
        # Written to $env:TEMP, not $LogsDir — this is a copy of the DBA script
        # with the real readonly login password substituted in, and $LogsDir is
        # wholesale-uploaded as part of the CI artifact (see check I).
        $realScriptPath = Join-Path $env:TEMP "nia-readonly-setup-real-$([guid]::NewGuid().ToString('N').Substring(0,8)).sql"
        Set-Content -Path $realScriptPath -Value $realScript

        $runResult = Invoke-Sqlcmd2 -InputFile $realScriptPath -LogName "C2-run-script"
        Add-Result -Check "C2.script-runs-cleanly" -Pass ($runResult.ExitCode -eq 0) -Detail $runResult.StdErr.Trim()
        Remove-Item -Path $realScriptPath -Force -ErrorAction SilentlyContinue

        $verify = Invoke-Sqlcmd2 -Query "SELECT COUNT(*) FROM sys.server_principals WHERE name = N'$ReadonlyLogin';" -LogName "C2-verify-login"
        Add-Result -Check "C2.readonly-login-created" -Pass ($verify.StdOut -match "1")
    }
}

function Invoke-CheckC3-WindowsOnlyAuth {
    Invoke-Section "CHECK C3: Windows-only auth mode is explained" {
        Set-SqlLoginMode -Mode 1
        $restarted = Restart-SqlInstanceAndWait -TimeoutSec 90
        Add-Result -Check "C3.setup.login-mode-switched" -Pass $restarted

        $homeDir = New-ThrowawayHome -Suffix "c3"
        $code = New-PairingCode
        $answers = @{
            pairing           = $code.composite
            platformUrl       = $FakePlatformUrl
            sqlInstanceChoice = "1"
            username          = $ReadonlyLogin
            password          = $ReadonlyLoginPassword
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 60 -LogName "C3-setup"
        Add-Result -Check "C3.windows-only-auth-explained" -Pass ($result.StdOut -match "password logins are switched off on this server")
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue

        Set-SqlLoginMode -Mode 2
        $restoredRestart = Restart-SqlInstanceAndWait -TimeoutSec 90
        Add-Result -Check "C3.setup.login-mode-restored" -Pass $restoredRestart
    }
}

function Invoke-CheckC4-WrongPassword {
    Invoke-Section "CHECK C4: wrong password gives a plain message, never echoed" {
        $homeDir = New-ThrowawayHome -Suffix "c4"
        $code = New-PairingCode
        $answers = @{
            pairing           = $code.composite
            platformUrl       = $FakePlatformUrl
            sqlInstanceChoice = "1"
            username          = $ReadonlyLogin
            password          = $WrongPassword
        }
        $answersPath = Join-Path $homeDir "answers.txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -HomeDir $homeDir -TimeoutSec 60 -LogName "C4-setup"
        Add-Result -Check "C4.wrong-password-plain-message" -Pass ($result.StdOut -match "Couldn't log in: wrong username or password")
        Add-Result -Check "C4.password-never-echoed" -Pass (-not ($result.StdOut -match [regex]::Escape($WrongPassword)))
        Remove-Item -Recurse -Force $homeDir -ErrorAction SilentlyContinue
    }
}

$script:RealPairingAgentId = $null
$script:RealConnectionId = $null

function Invoke-CheckC5-CorrectDetails {
    Invoke-Section "CHECK C5: correct details -> database offered, connection saved, test reports table count" {
        # Deliberately NOT using a throwaway NIA_AGENT_HOME here: this must
        # write into the real %ProgramData%\NiaAgent so the already-running
        # service (installed in check A) picks it up live for check D.
        $code = New-PairingCode
        $answers = @{
            pairing          = $code.composite
            platformUrl      = $FakePlatformUrl
            sqlInstanceChoice = "1"
            username         = $ReadonlyLogin
            password         = $ReadonlyLoginPassword
            dbChoice         = "1"
        }
        # Written to $env:TEMP, not $LogsDir — this answers file contains the
        # real readonly login password, and $LogsDir is wholesale-uploaded as
        # part of the CI artifact (see check I).
        $answersPath = Join-Path $env:TEMP "nia-agent-c5-answers-$([guid]::NewGuid().ToString('N').Substring(0,8)).txt"
        New-AnswersFile -Answers $answers -Path $answersPath
        $result = Invoke-NiaAgent -Arguments @("setup", "--answers-file", $answersPath) -TimeoutSec 60 -LogName "C5-setup"
        Remove-Item -Path $answersPath -Force -ErrorAction SilentlyContinue
        Add-Result -Check "C5.paired" -Pass ($result.StdOut -match "Paired as agent")
        Add-Result -Check "C5.databases-offered" -Pass ($result.StdOut -match [regex]::Escape($TestDbName))
        Add-Result -Check "C5.connected-with-table-count" -Pass ($result.StdOut -match "Connected\. \d+ table\(s\)/view\(s\) visible\.")

        $agentIdMatch = [regex]::Match($result.StdOut, "Paired as agent (\S+)")
        if ($agentIdMatch.Success) { $script:RealPairingAgentId = $agentIdMatch.Groups[1].Value }

        $listResult = Invoke-NiaAgent -Arguments @("connection", "list") -TimeoutSec 30 -LogName "C5-connection-list"
        $firstLine = ($listResult.StdOut -split "`n" | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1)
        if ($firstLine) { $script:RealConnectionId = ($firstLine -split "`t")[0] }
        Add-Result -Check "C5.connection-id-resolved" -Pass ([bool]$script:RealConnectionId) -Detail "$($script:RealConnectionId)"
    }
}

# ============================================================================
# CHECK D — the live service itself (no restart)
# ============================================================================

function Invoke-CheckD {
    Invoke-Section "CHECK D: live service checks in + runs a scheduled job, no restart" {
        if (-not $script:RealPairingAgentId -or -not $script:RealConnectionId) {
            Add-Result -Check "D.prerequisites" -Pass $false -Detail "check C5 did not produce a paired agent id / connection id"
            return
        }

        # D1: the running service (never restarted since check A) checks in
        # reporting the connection by name/database/dialect only.
        $checkedIn = $false
        $reportedConnections = $null
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            try {
                $info = Get-FakeAgentInfo -AgentId $script:RealPairingAgentId
                if ($info.reportedConnections -and $info.reportedConnections.Count -gt 0) {
                    $reportedConnections = $info.reportedConnections
                    $checkedIn = $true
                    break
                }
            } catch {}
            Start-Sleep -Seconds 2
        }
        Add-Result -Check "D1.service-checked-in-without-restart" -Pass $checkedIn
        if ($reportedConnections) {
            $conn = $reportedConnections[0]
            $hasNameOnly = ($conn.PSObject.Properties.Name -notcontains "host") -and ($conn.PSObject.Properties.Name -notcontains "user") -and ($conn.PSObject.Properties.Name -notcontains "password")
            Add-Result -Check "D1.connection-reported-by-name-only" -Pass $hasNameOnly -Detail ($conn | ConvertTo-Json -Compress)
        } else {
            Add-Result -Check "D1.connection-reported-by-name-only" -Pass $false -Detail "no reportedConnections seen"
        }

        # D2/D3: create a table on the fake Planometry matching dbo.Widgets,
        # add a job on a one-minute schedule, and wait for the live service
        # (via its own scheduler, no restart) to deliver the correct rows.
        $createTableBody = @{
            columns = @(
                @{ name = "Id"; type = "Number"; isKey = $true }
                @{ name = "Name"; type = "Text"; isKey = $false }
                @{ name = "UpdatedAt"; type = "DateTime"; isKey = $false }
            )
        } | ConvertTo-Json -Depth 5
        $table = Invoke-RestMethod -Method Post -Uri "$FakePlanometryControlUrl/create-table" -Body $createTableBody -ContentType "application/json"
        Add-Result -Check "D2.fake-planometry-table-created" -Pass ([bool]$table.tableUrl)

        $jobArgs = @(
            "job", "add",
            "--connection", $script:RealConnectionId,
            "--table", "dbo.Widgets",
            "--target-url", $table.tableUrl,
            "--name", "widgets-smoke",
            "--schedule", "* * * * *",
            "--yes"
        )
        $jobResult = Invoke-NiaAgent -Arguments $jobArgs -StdIn "$($table.pushKey)`n" -TimeoutSec 30 -LogName "D-job-add"
        Add-Result -Check "D2.job-added" -Pass ($jobResult.StdOut -match "added job") -Detail ($jobResult.StdOut -split "`n" | Select-Object -First 1)

        $rowsOk = $false
        $rowsDetail = ""
        $deadline = (Get-Date).AddSeconds(100)
        while ((Get-Date) -lt $deadline) {
            try {
                $rowsResp = Invoke-RestMethod -Method Get -Uri "$FakePlanometryControlUrl/rows?tableId=$($table.tableId)"
                if ($rowsResp.rows -and $rowsResp.rows.Count -eq 3) {
                    $names = $rowsResp.rows | ForEach-Object { $_.Name } | Sort-Object
                    if (($names -join ",") -eq "Widget One,Widget Three,Widget Two") {
                        $rowsOk = $true
                        break
                    }
                    $rowsDetail = "row count ok but names mismatch: $($names -join ',')"
                } else {
                    $rowsDetail = "rows so far: $($rowsResp.rows.Count)"
                }
            } catch {
                $rowsDetail = $_.Exception.Message
            }
            Start-Sleep -Seconds 3
        }
        Add-Result -Check "D3.scheduled-job-delivered-correct-rows" -Pass $rowsOk -Detail $rowsDetail
    }
}

# ============================================================================
# CHECK E — reinstall over the top
# ============================================================================

function Invoke-CheckE {
    Invoke-Section "CHECK E: reinstall over the top keeps pairing/connection/job" {
        $result = Invoke-Proc -FilePath $SetupExe.FullName -Arguments @("/S") -TimeoutSec 420 -LogName "E-reinstall"
        Copy-InstallDiagnostics -Tag "E-reinstall"
        Add-Result -Check "E.installer-exit-code" -Pass ($result.ExitCode -eq 0) -Detail "exit=$($result.ExitCode)"
        Test-FreshInstallInvariants -Prefix "E"

        $statusResult = Invoke-NiaAgent -Arguments @("status") -TimeoutSec 30 -LogName "E-status"
        Add-Result -Check "E.still-paired" -Pass ($statusResult.StdOut -match "link: paired to")

        $connResult = Invoke-NiaAgent -Arguments @("connection", "list") -TimeoutSec 30 -LogName "E-connection-list"
        Add-Result -Check "E.connection-kept" -Pass ($connResult.StdOut -match [regex]::Escape($TestDbName))

        $jobResult = Invoke-NiaAgent -Arguments @("job", "list") -TimeoutSec 30 -LogName "E-job-list"
        Add-Result -Check "E.job-kept" -Pass ($jobResult.StdOut -match "widgets-smoke")
    }
}

# ============================================================================
# CHECK F — replace a stuck service at the legacy 32-bit path
# ============================================================================

function Invoke-CheckF {
    Invoke-Section "CHECK F: replaces a stuck service from Program Files (x86) cleanly" {
        New-Item -ItemType Directory -Force -Path $LegacyX86Dir | Out-Null
        Set-Content -Path (Join-Path $LegacyX86Dir "dummy.txt") -Value "simulated leftover v0.0.2 install"

        $result = Invoke-Proc -FilePath $SetupExe.FullName -Arguments @("/S") -TimeoutSec 420 -LogName "F-reinstall-over-legacy"
        Copy-InstallDiagnostics -Tag "F-reinstall-over-legacy"
        Add-Result -Check "F.installer-exit-code" -Pass ($result.ExitCode -eq 0) -Detail "exit=$($result.ExitCode)"
        Test-FreshInstallInvariants -Prefix "F"
        Add-Result -Check "F.legacy-x86-dir-removed" -Pass (-not (Test-Path $LegacyX86Dir))
    }
}

# ============================================================================
# CHECK G — uninstall keeping vs. purging settings
# ============================================================================

function Invoke-CheckG {
    Invoke-Section "CHECK G: uninstall keeping settings, then reinstall, then purge" {
        $uninstallExe = Join-Path $InstallDir "Uninstall.exe"
        $r1 = Invoke-Proc -FilePath $uninstallExe -Arguments @("/S") -TimeoutSec 300 -LogName "G-uninstall-keep"
        Copy-InstallDiagnostics -Tag "G-uninstall-keep"
        Add-Result -Check "G.uninstall-exit-code" -Pass ($r1.ExitCode -eq 0) -Detail "exit=$($r1.ExitCode)"
        Start-Sleep -Seconds 3
        Add-Result -Check "G.service-removed" -Pass (-not (Get-Service -Name "nia-agent" -ErrorAction SilentlyContinue))
        Add-Result -Check "G.program-files-removed" -Pass (-not (Test-Path $InstallDir))
        Add-Result -Check "G.start-menu-removed" -Pass (-not (Test-Path $StartMenuDir))
        Add-Result -Check "G.registry-entry-removed" -Pass (-not (Get-ItemProperty -Path $UninstKeyPath -ErrorAction SilentlyContinue))
        Add-Result -Check "G.data-dir-kept" -Pass (Test-Path $RealDataDir)

        $reinstall = Invoke-Proc -FilePath $SetupExe.FullName -Arguments @("/S") -TimeoutSec 420 -LogName "G-reinstall-after-keep"
        Copy-InstallDiagnostics -Tag "G-reinstall-after-keep"
        Add-Result -Check "G.reinstall-exit-code" -Pass ($reinstall.ExitCode -eq 0) -Detail "exit=$($reinstall.ExitCode)"
        $statusResult = Invoke-NiaAgent -Arguments @("status") -TimeoutSec 30 -LogName "G-status-after-reinstall"
        Add-Result -Check "G.still-paired-after-reinstall" -Pass ($statusResult.StdOut -match "link: paired to")

        $uninstallExe2 = Join-Path $InstallDir "Uninstall.exe"
        $r2 = Invoke-Proc -FilePath $uninstallExe2 -Arguments @("/S", "/PURGE") -TimeoutSec 300 -LogName "G-uninstall-purge"
        Copy-InstallDiagnostics -Tag "G-uninstall-purge"
        Add-Result -Check "G.purge-uninstall-exit-code" -Pass ($r2.ExitCode -eq 0) -Detail "exit=$($r2.ExitCode)"
        Start-Sleep -Seconds 3
        Add-Result -Check "G.data-dir-removed-after-purge" -Pass (-not (Test-Path $RealDataDir))
    }
}

# ============================================================================
# CHECK H — zip package, install.ps1 from 32-bit PowerShell
# ============================================================================

function Invoke-CheckH {
    Invoke-Section "CHECK H: zip bundle's install.ps1 self-corrects from 32-bit PowerShell" {
        $extractDir = Join-Path $env:TEMP "nia-agent-zip-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        Expand-Archive -Path $ZipBundle.FullName -DestinationPath $extractDir -Force
        $installScript = Get-ChildItem -Path $extractDir -Filter "install.ps1" -Recurse | Select-Object -First 1
        Add-Result -Check "H.bundle-has-install-script" -Pass ([bool]$installScript)
        if (-not $installScript) { return }

        $psWow64 = Join-Path $env:WINDIR "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
        $result = Invoke-Proc -FilePath $psWow64 -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installScript.FullName) `
            -WorkingDirectory $installScript.DirectoryName -TimeoutSec 420 -LogName "H-install-from-32bit"
        Copy-InstallDiagnostics -Tag "H-install-from-32bit"
        Add-Result -Check "H.install-exit-code" -Pass ($result.ExitCode -eq 0) -Detail "exit=$($result.ExitCode)"
        Test-FreshInstallInvariants -Prefix "H"

        Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# CHECK I — nothing sensitive ever appears in logs/output
# ============================================================================

function Invoke-CheckI {
    Invoke-Section "CHECK I: no secret ever appears in any captured log/output" {
        $secrets = @($SqlSaPassword, $ReadonlyLoginPassword, $WrongPassword)
        $allLogFiles = Get-ChildItem -Path $LogsDir -File -Recurse -ErrorAction SilentlyContinue
        $leaks = @()
        foreach ($file in $allLogFiles) {
            $content = Get-Content -Path $file.FullName -Raw -ErrorAction SilentlyContinue
            if (-not $content) { continue }
            foreach ($secret in $secrets) {
                if ($secret -and $content.Contains($secret)) {
                    $leaks += "$($file.Name): contains a tracked secret value"
                }
            }
        }
        Add-Result -Check "I.no-secrets-in-logs" -Pass ($leaks.Count -eq 0) -Detail ($leaks -join "; ")
    }
}

# ============================================================================
# Main
# ============================================================================

Start-FakeServers
try {
    Invoke-CheckA
    Invoke-CheckB1
    Invoke-CheckB2
    Invoke-CheckB3
    Initialize-TestDatabase
    Invoke-CheckC1-TcpDisabled
    Enable-SqlTcpForTesting
    Invoke-CheckC2-DbaScript
    Invoke-CheckC3-WindowsOnlyAuth
    Invoke-CheckC4-WrongPassword
    Invoke-CheckC5-CorrectDetails
    Invoke-CheckD
    Invoke-CheckE
    Invoke-CheckF
    Invoke-CheckG
    Invoke-CheckH
    Invoke-CheckI
} finally {
    Stop-FakeServers
}

# ============================================================================
# Report
# ============================================================================

Write-Host ""
Write-Host "==================== SUMMARY ===================="
$script:Results | ForEach-Object {
    $status = if ($_.Pass) { "PASS" } else { "FAIL" }
    Write-Host ("{0,-6} {1,-45} {2}" -f $status, $_.Check, $_.Detail)
}

$script:Results | Export-Csv -Path (Join-Path $ArtifactsDir "results.csv") -NoTypeInformation
$script:Results | ForEach-Object {
    $status = if ($_.Pass) { "PASS" } else { "FAIL" }
    "{0,-6} {1,-45} {2}" -f $status, $_.Check, $_.Detail
} | Set-Content -Path (Join-Path $ArtifactsDir "results.txt")

$failures = $script:Results | Where-Object { -not $_.Pass }
Write-Host ""
Write-Host "total: $($script:Results.Count)  passed: $($script:Results.Count - $failures.Count)  failed: $($failures.Count)"

if ($failures.Count -gt 0) {
    exit 1
}
exit 0

#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs SQL Server Express with a named instance on a GitHub Actions
  windows-latest runner, for the windows-installer workflow's check C
  ("database questions against real SQL Server Express").

.DESCRIPTION
  windows-latest runner images do NOT ship with SQL Server pre-installed
  (confirmed: actions/runner-images has no SQL Server entry for Windows
  images), so this installs it via Chocolatey (already present on every
  GitHub-hosted Windows runner — no extra download infra needed).

  Installed in mixed-mode auth (SQL + Windows logins) with a generated,
  masked `sa` password, so the test script can create/alter logins and
  flip authentication/TCP settings itself to exercise every branch of
  `nia-agent setup`'s database step — while nia-agent's own login
  attempts during the tests always use a *separate*, deliberately
  low-privilege login (never `sa`).

  TCP/IP is deliberately left at its SQL Express *default* (disabled) —
  check C's first scenario is exactly "TCP/IP disabled -> explains +
  steps", so the test script enables TCP itself, after that scenario
  has been exercised, via SMO (the officially documented way, since the
  installer's own /TCPENABLED switch is unreliable per Chocolatey's own
  docs).
#>

$ErrorActionPreference = "Stop"

$InstanceName = "NIAEXPRESS"
$SaPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
Write-Host "::add-mask::$SaPassword"

Write-Host "Installing sqlcmd via Chocolatey..."
choco install sqlcmd -y --no-progress
if ($LASTEXITCODE -ne 0) {
  throw "choco install sqlcmd failed with exit code $LASTEXITCODE"
}
# Chocolatey installs sqlcmd.exe's shim but the current session's PATH
# may not have picked it up yet — refresh from the machine/user env so
# later steps in this same job can call `sqlcmd` directly.
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
"PATH=$env:PATH" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

Write-Host "Installing SQL Server Express (instance $InstanceName) via Chocolatey..."
$packageParams = "/IACCEPTSQLSERVERLICENSETERMS /INSTANCENAME=$InstanceName /SECURITYMODE=SQL /SAPWD=$SaPassword /UPDATEENABLED=False /SQLSVCSTARTUPTYPE=Automatic"
choco install sql-server-express -y --no-progress --package-parameters "$packageParams" --timeout 1800
if ($LASTEXITCODE -ne 0) {
  throw "choco install sql-server-express failed with exit code $LASTEXITCODE"
}

$serviceName = "MSSQL`$$InstanceName"
Write-Host "Waiting for service $serviceName to exist and start..."
$deadline = (Get-Date).AddMinutes(5)
$svc = $null
while ((Get-Date) -lt $deadline) {
  $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq "Running") { break }
  Start-Sleep -Seconds 5
}
if (-not $svc -or $svc.Status -ne "Running") {
  throw "SQL Server service $serviceName did not reach Running state within 5 minutes (found: $($svc.Status))"
}
Write-Host "SQL Server Express instance $InstanceName is running."

# Hand the instance name + generated sa password to the test job's later
# steps via GITHUB_ENV (masked above, so it never appears in plain text
# in the workflow's own logs even if a later step echoes $env:SQL_SA_PASSWORD).
"SQL_INSTANCE_NAME=$InstanceName" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"SQL_SA_PASSWORD=$SaPassword" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

Write-Host "SQL Server Express setup complete."

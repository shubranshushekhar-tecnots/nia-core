@echo off
REM Thin launcher for nia-agent-updater.ps1, invoked directly as the
REM NiaAgentUpdater Scheduled Task's Action (see install.ps1 step e).
REM
REM Exists purely so a failure that happens BEFORE the PowerShell script
REM itself gets a chance to run any of its own Write-Log/trap logic (a
REM parse error, an ExecutionPolicy/Group-Policy block, powershell.exe
REM not resolving on PATH, etc.) is still captured somewhere -- Task
REM Scheduler attaches no console to a non-interactive task, so anything
REM powershell.exe would otherwise print to stdout/stderr is silently
REM discarded without this. Appends (not overwrites) so a history of
REM every run attempt survives across repeated "check now" triggers.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0nia-agent-updater.ps1" >> "%ProgramData%\NiaAgent\update\launcher.log" 2>&1
exit /b %ERRORLEVEL%

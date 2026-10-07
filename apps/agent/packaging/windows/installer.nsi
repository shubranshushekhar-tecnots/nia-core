; NSIS installer for the Nia Core Agent. Built by build-installer.mjs,
; which stages the same files build-bundle.mjs zips (agent SEA exe, pinned
; WinSW binary + descriptor, install/uninstall PowerShell scripts) and
; invokes makensis with -DSTAGE_DIR/-DVERSION.
;
; Design: the heavy lifting (data-dir ACL ordering, SID usage, idempotent
; upgrade-in-place) already lives in install.ps1 (packaging/windows/
; install.ps1) and is already tested there (install.test.ts) — this
; installer just runs that same script elevated, rather than
; re-implementing service/ACL logic in NSIS. The uninstaller does its own
; small, inline stop/unregister (via the bundled WinSW binary directly)
; so NSIS's native self-deleting-uninstaller mechanism for "RMDir /r" on
; the folder containing the running Uninstall.exe works without a second
; process racing it.

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR must be defined: makensis -DSTAGE_DIR=<path> -DVERSION=<version> installer.nsi"
!endif

!define PRODUCT_NAME "Nia Core Agent"
!define PRODUCT_PUBLISHER "Nia Core"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NiaCoreAgent"
!define START_MENU_DIR "Nia Core Agent"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Name "${PRODUCT_NAME}"
OutFile "dist\NiaCoreAgent-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\NiaAgent"
RequestExecutionLevel admin
Unicode true
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

Var DataDir
Var PowerShellExe
Var CmdExe
Var UninstPurge

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Set up now (recommended)"
!define MUI_FINISHPAGE_RUN_FUNCTION "RunSetupNow"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Nia Core Agent requires 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64
  ReadEnvStr $DataDir "ProgramData"
  StrCpy $DataDir "$DataDir\NiaAgent"
FunctionEnd

Function un.onInit
  SetRegView 64
  ReadEnvStr $DataDir "ProgramData"
  StrCpy $DataDir "$DataDir\NiaAgent"
  StrCpy $UninstPurge "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "/PURGE" $R1
  ${IfNot} ${Errors}
    StrCpy $UninstPurge "1"
  ${EndIf}
  ClearErrors
FunctionEnd

Function RunSetupNow
  Call GetCmdExe
  Exec '"$CmdExe" /k ""$INSTDIR\nia-agent.exe" setup"'
FunctionEnd

; makensis builds a plain 32-bit installer executable, so on 64-bit
; Windows this process runs under WOW64 — meaning $SYSDIR is silently
; redirected to SysWOW64, and a naive "$SYSDIR\...\powershell.exe" would
; launch 32-bit PowerShell. That 32-bit PowerShell then sees $env:ProgramFiles
; as "Program Files (x86)", which is exactly how v0.0.2 ended up with
; install.ps1 computing a different install folder than the one this
; installer actually extracted files into. Fix: use the "Sysnative" alias,
; which bypasses WOW64 redirection and always points at the real 64-bit
; System32 — but only exists for WOW64 processes, so fall back to the
; plain System32 path if it's not there (this installer running natively).
Function GetPowerShellExe
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $PowerShellExe "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $PowerShellExe "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
FunctionEnd

; Same WOW64 problem as GetPowerShellExe above, for cmd.exe: a plain
; "$SYSDIR\cmd.exe" resolves to SysWOW64 under this 32-bit installer
; process, launching the 32-bit cmd.exe instead of the native 64-bit one.
; Harmless for running nia-agent.exe itself (CreateProcess works across
; bitness for a separate child exe), but inconsistent with this installer's
; "64-bit only, always" rule, so resolve it the same way.
Function GetCmdExe
  ${If} ${FileExists} "$WINDIR\Sysnative\cmd.exe"
    StrCpy $CmdExe "$WINDIR\Sysnative\cmd.exe"
  ${Else}
    StrCpy $CmdExe "$WINDIR\System32\cmd.exe"
  ${EndIf}
FunctionEnd

; Patches the "Run as administrator" compatibility bit into a .lnk file
; (byte offset 0x15, bit 0x20 — the documented shortcut link-flags byte).
; The agent's data folder is ACL'd to Administrators + its own virtual
; service account only (install.ps1), so an unelevated double-click of
; these Start Menu shortcuts would just fail to read the agent's config.
Function MarkShortcutElevated
  Exch $0
  FileOpen $1 "$0" a
  FileSeek $1 21 SET
  FileReadByte $1 $2
  IntOp $2 $2 | 0x20
  FileSeek $1 21 SET
  FileWriteByte $1 $2
  FileClose $1
  Pop $0
FunctionEnd

Section "Install" SEC01
  SetOutPath "$INSTDIR"
  File "${STAGE_DIR}\nia-agent.exe"
  File "${STAGE_DIR}\nia-agent-service.exe"
  File "${STAGE_DIR}\nia-agent-service.xml"
  File "${STAGE_DIR}\LICENSE-WinSW.txt"
  File "${STAGE_DIR}\install.ps1"
  File "${STAGE_DIR}\uninstall.ps1"
  File "${STAGE_DIR}\VERSION.txt"

  DetailPrint "Registering and starting the nia-agent service (stop -> replace -> start if upgrading)..."
  Call GetPowerShellExe
  nsExec::ExecToLog '"$PowerShellExe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -InPlace'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Installing the nia-agent service failed. See the log at $DataDir\install.log (or %TEMP%\nia-agent-install.log if that folder could not be written) for which step failed, or run install.ps1 manually from $INSTDIR as Administrator."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${START_MENU_DIR}"
  Call GetCmdExe
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Setup.lnk" "$CmdExe" '/k ""$INSTDIR\nia-agent.exe" setup"' "$INSTDIR\nia-agent.exe" 0
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Status.lnk" "$CmdExe" '/k ""$INSTDIR\nia-agent.exe" status"' "$INSTDIR\nia-agent.exe" 0
  Push "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Setup.lnk"
  Call MarkShortcutElevated
  Push "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Status.lnk"
  Call MarkShortcutElevated

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\nia-agent.exe"
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Silent uninstalls (/S, used by CI and scripted IT deployments) never show
  ; the keep/purge MessageBox below -- there is no one to click it, and an
  ; un-guarded MessageBox here would hang forever. Silent uninstalls default
  ; to "keep" (matching uninstall.ps1's own -Purge-opt-in default); pass
  ; /PURGE on the uninstaller's command line to force deleting $DataDir too
  ; without a prompt.
  ${If} $UninstPurge == "1"
    StrCpy $0 "purge"
  ${ElseIf} ${Silent}
    StrCpy $0 "keep"
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep this agent's configuration, secrets, and logs?$\n$\nYes = keep them in $DataDir (useful if you plan to reinstall)$\nNo = delete them too" IDYES KeepData
    StrCpy $0 "purge"
    Goto StopService
    KeepData:
    StrCpy $0 "keep"
    StopService:
  ${EndIf}

  DetailPrint "Stopping and unregistering the nia-agent service..."
  nsExec::ExecToLog '"$INSTDIR\nia-agent-service.exe" stop'
  Pop $1
  nsExec::ExecToLog '"$INSTDIR\nia-agent-service.exe" uninstall'
  Pop $1

  ${If} $0 == "purge"
    RMDir /r "$DataDir"
  ${EndIf}

  Delete "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Setup.lnk"
  Delete "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Status.lnk"
  RMDir "$SMPROGRAMS\${START_MENU_DIR}"

  DeleteRegKey HKLM "${UNINST_KEY}"

  RMDir /r "$INSTDIR"
SectionEnd

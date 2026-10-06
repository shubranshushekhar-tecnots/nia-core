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
FunctionEnd

Function RunSetupNow
  Exec '"$SYSDIR\cmd.exe" /k ""$INSTDIR\nia-agent.exe" setup"'
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
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Installing the nia-agent service failed (exit code $0). Check the details above, or run install.ps1 manually from $INSTDIR as Administrator."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${START_MENU_DIR}"
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Setup.lnk" "$SYSDIR\cmd.exe" '/k ""$INSTDIR\nia-agent.exe" setup"' "$INSTDIR\nia-agent.exe" 0
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent Status.lnk" "$SYSDIR\cmd.exe" '/k ""$INSTDIR\nia-agent.exe" status"' "$INSTDIR\nia-agent.exe" 0
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
  MessageBox MB_YESNO|MB_ICONQUESTION "Keep this agent's configuration, secrets, and logs?$\n$\nYes = keep them in $DataDir (useful if you plan to reinstall)$\nNo = delete them too" IDYES KeepData
  StrCpy $0 "purge"
  Goto StopService
  KeepData:
  StrCpy $0 "keep"
  StopService:

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

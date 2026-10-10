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
!include "WinVer.nsh"

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
  ; RequestExecutionLevel admin elevates privileges but does NOT, by
  ; itself, switch $SMPROGRAMS/$DESKTOP to the all-users context -- NSIS
  ; defaults those to the current (installing) user's personal profile
  ; unless this is called explicitly. Without it, Start Menu shortcuts
  ; silently land in that one user's own Start Menu instead of the
  ; shared "All Users" one, invisible to any other session on this
  ; machine-wide, HKLM-registered, service-based install.
  SetShellVarContext all
  ReadEnvStr $DataDir "ProgramData"
  StrCpy $DataDir "$DataDir\NiaAgent"
FunctionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
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

; On Windows 10+ with the desktop app staged, the Electron shell
; (NiaAgentDesktop\Nia Agent.exe) IS the setup experience -- it opens
; straight to the agent's own UI (pairing included). On pre-Win10 (or if
; the desktop build wasn't staged for any reason -- the FileExists guard
; below), fall back to the same plain browser-based flow as the main
; Start Menu shortcut: `nia-agent.exe open`. Neither branch may ever show
; a visible console window -- nsExec::ExecToLog (not plain Exec) is what
; suppresses it for this console-subsystem exe. The interactive CLI setup
; wizard (`nia-agent.exe setup`, in a visible cmd window) only remains
; reachable via the "(advanced)" shortcut.
Function RunSetupNow
  ${If} ${AtLeastWin10}
  ${AndIf} ${FileExists} "$INSTDIR\NiaAgentDesktop\Nia Agent.exe"
    Exec '"$INSTDIR\NiaAgentDesktop\Nia Agent.exe"'
  ${Else}
    nsExec::ExecToLog '"$INSTDIR\nia-agent.exe" open'
    Pop $0
  ${EndIf}
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

; The running Electron shell holds its own exe/DLLs open on Windows --
; overwriting them in place (upgrade) or deleting them (uninstall) fails
; silently-to-partially while it's running. Graceful quit first (lets it
; save window position/state via its own before-quit handler), then a
; forced kill in case it ignored the graceful request or isn't responding.
; Both calls are allowed to "fail" (exit non-zero) when the process simply
; isn't running at all -- that's the common case, not an error.
;
; A macro, not a Function: Section "Install" and Section "Uninstall" compile
; into two separate binaries (the installer and Uninstall.exe), and a plain
; Function is only reachable from the former -- only "un."-prefixed
; Functions or macros can be used in both.
!macro CloseAgentDesktopApp
  DetailPrint "Closing Nia Agent if it's running..."
  nsExec::ExecToLog 'taskkill /IM "Nia Agent.exe" /T'
  Pop $0
  Sleep 1500
  nsExec::ExecToLog 'taskkill /F /IM "Nia Agent.exe" /T'
  Pop $0
!macroend

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
  !insertmacro CloseAgentDesktopApp
  SetOutPath "$INSTDIR"
  File "${STAGE_DIR}\nia-agent.exe"
  File "${STAGE_DIR}\nia-agent-service.exe"
  File "${STAGE_DIR}\nia-agent-service.xml"
  File "${STAGE_DIR}\LICENSE-WinSW.txt"
  File "${STAGE_DIR}\install.ps1"
  File "${STAGE_DIR}\uninstall.ps1"
  File "${STAGE_DIR}\VERSION.txt"

  ; The desktop shell (apps/agent-desktop) is staged by build-installer.mjs
  ; as a NiaAgentDesktop\ subfolder -- required by default there (missing
  ; output is a hard build-time error), staged here only when present
  ; because a deliberate --no-desktop (service-only) build, or a pre-Win10
  ; target (Electron doesn't support it anyway), legitimately has none.
  ; Both cases fall back to the plain browser-based "nia-agent.exe open"
  ; shortcut below with no error at install time.
  ${If} ${AtLeastWin10}
  ${AndIf} ${FileExists} "${STAGE_DIR}\NiaAgentDesktop\*.*"
    SetOutPath "$INSTDIR\NiaAgentDesktop"
    File /r "${STAGE_DIR}\NiaAgentDesktop\*.*"
    SetOutPath "$INSTDIR"
  ${EndIf}

  DetailPrint "Registering and starting the nia-agent service (stop -> replace -> start if upgrading)..."
  Call GetPowerShellExe
  nsExec::ExecToLog '"$PowerShellExe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -InPlace'
  Pop $0
  ${If} $0 != 0
    ; Silent installs (/S, used by CI and scripted IT deployments) have no one
    ; to dismiss a MessageBox -- an un-guarded one here would hang forever,
    ; same reasoning as the uninstaller's keep/purge prompt below. Just log
    ; and abort instead.
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Installing the nia-agent service failed. See the log at $DataDir\install.log (or %TEMP%\nia-agent-install.log if that folder could not be written) for which step failed, or run install.ps1 manually from $INSTDIR as Administrator."
    ${EndIf}
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${START_MENU_DIR}"
  ; Main shortcut: on Win10+ with the desktop app staged, point straight at
  ; the Electron shell (apps/agent-desktop) -- it owns the same OTC->session
  ; flow itself, just in a native window instead of the default browser.
  ; Pre-Win10 (or if the desktop build wasn't staged for any reason) falls
  ; back to the original Phase 2 M2 behavior: `nia-agent.exe open` trades the
  ; on-disk bearer token for a 60s single-use OTC and opens the agent's UI in
  ; the default browser -- no admin elevation needed either way, since
  ; reading the already-ACL'd local-api\ token only requires the read-only
  ; ACE install.ps1 already grants the installing user, not membership in
  ; Administrators.
  ${If} ${AtLeastWin10}
  ${AndIf} ${FileExists} "$INSTDIR\NiaAgentDesktop\Nia Agent.exe"
    CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent.lnk" "$INSTDIR\NiaAgentDesktop\Nia Agent.exe" "" "$INSTDIR\NiaAgentDesktop\Nia Agent.exe" 0
  ${Else}
    CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent.lnk" "$INSTDIR\nia-agent.exe" 'open' "$INSTDIR\nia-agent.exe" 0
  ${EndIf}

  ; Always the plain System32 cmd.exe path below (never a Sysnative-resolved
  ; one) -- CreateShortCut never launches anything itself, it just writes a
  ; target path string into a .lnk file, read later by whatever process the
  ; user double-clicks it from (a native 64-bit Explorer on this installer's
  ; 64-bit-only target, where "Sysnative" isn't a valid path at all). Baking
  ; in a Sysnative-resolved path here was the actual bug behind "the
  ; Setup/Status shortcut does nothing the second time".
  ;
  ; Renamed to "(advanced)" (Phase 2 M2) now that the plain "Nia Core
  ; Agent.lnk" above covers normal day-to-day use -- these two remain for
  ; re-running the setup wizard or checking raw CLI status text.
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Setup.lnk" "$WINDIR\System32\cmd.exe" '/k ""$INSTDIR\nia-agent.exe" setup"' "$INSTDIR\nia-agent.exe" 0
  CreateShortCut "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Status.lnk" "$WINDIR\System32\cmd.exe" '/k ""$INSTDIR\nia-agent.exe" status"' "$INSTDIR\nia-agent.exe" 0
  Push "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Setup.lnk"
  Call MarkShortcutElevated
  Push "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Status.lnk"
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

  !insertmacro CloseAgentDesktopApp

  DetailPrint "Stopping and unregistering the nia-agent service..."
  nsExec::ExecToLog '"$INSTDIR\nia-agent-service.exe" stop'
  Pop $1
  nsExec::ExecToLog '"$INSTDIR\nia-agent-service.exe" uninstall'
  Pop $1

  ${If} $0 == "purge"
    RMDir /r "$DataDir"
  ${EndIf}

  Delete "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent.lnk"
  Delete "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Setup.lnk"
  Delete "$SMPROGRAMS\${START_MENU_DIR}\Nia Core Agent (advanced) - Status.lnk"
  RMDir "$SMPROGRAMS\${START_MENU_DIR}"

  DeleteRegKey HKLM "${UNINST_KEY}"

  RMDir /r "$INSTDIR"
SectionEnd

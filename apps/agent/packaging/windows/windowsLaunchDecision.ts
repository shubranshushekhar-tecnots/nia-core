// Mirrors installer.nsi's `${AtLeastWin10}` gate (WinVer.nsh), which
// decides whether the finish page / Start Menu shortcut launches the
// Electron shell (NiaAgentDesktop\Nia Agent.exe) or falls back to the
// plain browser-based `nia-agent.exe open` flow -- see installer.nsi's
// Section "Install" and RunSetupNow for the actual (NSIS) decision this
// documents and tests. Windows 10 and Windows Server 2016 share
// majorVersion 10 (Server editions are distinguished by product type,
// not version number), and are the first releases the Electron shell
// ships for; anything older (Windows Server 2012 R2 / Windows 8.1 = 6.3,
// etc.) gets the browser fallback.
export interface WindowsVersion {
  majorVersion: number;
  minorVersion: number;
  buildNumber: number;
}

export type WindowsLaunchMode = "electron" | "browser";

export function decideWindowsLaunchMode(version: WindowsVersion): WindowsLaunchMode {
  return version.majorVersion >= 10 ? "electron" : "browser";
}

/**
 * Thin wrapper over Electron's `app.setLoginItemSettings`/`getLoginItemSettings` (the only API
 * needed for "start at login", on both Windows and macOS) -- kept behind this narrow interface so
 * it's mockable in tests without a real Electron runtime.
 */
export interface LoginItemApi {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export function isStartAtLoginEnabled(app: LoginItemApi): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

/** Called once on first run only (see main.ts) -- "starts at login by default, user can turn it off". */
export function enableStartAtLoginByDefault(app: LoginItemApi): void {
  app.setLoginItemSettings({ openAtLogin: true });
}

export function setStartAtLogin(app: LoginItemApi, enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

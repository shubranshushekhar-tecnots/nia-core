import { Menu, Tray, nativeImage } from "electron";
import { defaultHomeDir, readApiToken, readPortFile } from "../agentPaths.js";
import { fetchAgentStatus } from "../agentClient.js";
import { isStartAtLoginEnabled, setStartAtLogin, type LoginItemApi } from "../autoLaunch.js";
import { APP_DISPLAY_NAME, STATUS_POLL_INTERVAL_MS } from "../constants.js";
import { trayIconPath } from "./icons.js";
import { mapStatusToConnectionState, type ConnectionColor } from "./statusState.js";

export interface TrayManagerOptions {
  assetsDir: string;
  loginItemApi: LoginItemApi;
  onOpen: () => void;
  onQuit: () => void;
}

/** Owns the Tray icon/menu and the ~15s status poll. Thin glue over the already-tested pure
 * mapStatusToConnectionState/trayIconPath/fetchAgentStatus -- not independently unit-tested since
 * it has no logic of its own beyond wiring, and Electron's Tray/Menu classes require a running app. */
export class TrayManager {
  private readonly tray: Tray;
  private readonly pollTimer: NodeJS.Timeout;
  private currentColor: ConnectionColor | null = null;

  constructor(private readonly options: TrayManagerOptions) {
    this.tray = new Tray(nativeImage.createFromPath(trayIconPath(options.assetsDir, "grey")));
    this.tray.setToolTip(APP_DISPLAY_NAME);
    this.tray.on("click", () => this.options.onOpen());
    this.rebuildMenu("Checking connection...");
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), STATUS_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    const dir = defaultHomeDir();
    const portInfo = readPortFile(dir);
    const token = readApiToken(dir);
    const status = portInfo && token ? await fetchAgentStatus(portInfo.port, token) : null;
    const state = mapStatusToConnectionState(status);
    this.setColor(state.color);
    this.rebuildMenu(state.label);
  }

  private setColor(color: ConnectionColor): void {
    if (color === this.currentColor) return;
    this.currentColor = color;
    this.tray.setImage(nativeImage.createFromPath(trayIconPath(this.options.assetsDir, color)));
  }

  private rebuildMenu(statusLabel: string): void {
    const startAtLogin = isStartAtLoginEnabled(this.options.loginItemApi);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${APP_DISPLAY_NAME}`, click: () => this.options.onOpen() },
        { label: statusLabel, enabled: false },
        { type: "separator" },
        {
          label: "Start at login",
          type: "checkbox",
          checked: startAtLogin,
          click: (item) => setStartAtLogin(this.options.loginItemApi, item.checked),
        },
        { type: "separator" },
        { label: "Quit", click: () => this.options.onQuit() },
      ]),
    );
  }

  destroy(): void {
    clearInterval(this.pollTimer);
    this.tray.destroy();
  }
}

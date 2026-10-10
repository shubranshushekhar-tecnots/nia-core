import { Menu, Tray, nativeImage, nativeTheme, systemPreferences } from "electron";
import { defaultHomeDir, readApiToken, readPortFile } from "../agentPaths.js";
import { fetchAgentStatus } from "../agentClient.js";
import { isStartAtLoginEnabled, setStartAtLogin, type LoginItemApi } from "../autoLaunch.js";
import { APP_DISPLAY_NAME, STATUS_POLL_INTERVAL_MS } from "../constants.js";
import {
  START_FRAME_COUNT,
  START_FRAME_INTERVAL_MS,
  SYNC_FRAME_COUNT,
  SYNC_FRAME_INTERVAL_MS,
  SYNC_TAIL_MS,
  nextFrame,
  trayIconPath,
} from "./icons.js";
import { mapStatusToConnectionState, type TrayStateKind } from "./statusState.js";

export interface TrayManagerOptions {
  assetsDir: string;
  loginItemApi: LoginItemApi;
  onOpen: () => void;
  onQuit: () => void;
}

/** Owns the Tray icon/menu, the ~15s status poll, and the per-state frame animation: idle/off/problem
 * are static; "starting" plays its build-up once then holds on idle; "syncing" loops its cascade for
 * as long as a job is actually running, with a short tail so a quick finish doesn't look like an
 * abrupt cut. Thin glue over the already-tested pure mapStatusToConnectionState/trayIconPath/
 * fetchAgentStatus -- not independently unit-tested since it has no logic of its own beyond wiring,
 * and Electron's Tray/Menu/nativeTheme/systemPreferences require a running app. */
export class TrayManager {
  private readonly tray: Tray;
  private readonly pollTimer: NodeJS.Timeout;
  private currentState: TrayStateKind | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private syncTailTimer: NodeJS.Timeout | null = null;
  private frame = 1;

  constructor(private readonly options: TrayManagerOptions) {
    this.tray = new Tray(nativeImage.createFromPath(trayIconPath(options.assetsDir, "off")));
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
    this.applyState(state.kind);
    this.rebuildMenu(state.label);
  }

  /** Only macOS exposes this; other platforms just always animate. */
  private prefersReducedMotion(): boolean {
    if (process.platform !== "darwin") return false;
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  }

  private applyState(kind: TrayStateKind): void {
    if (kind === this.currentState) {
      // Still syncing -- cancel any pending tail switch scheduled by a since-superseded poll.
      if (kind === "syncing" && this.syncTailTimer) {
        clearTimeout(this.syncTailTimer);
        this.syncTailTimer = null;
      }
      return;
    }

    if (this.currentState === "syncing" && kind !== "syncing") {
      // Let the current cascade finish its loop plus a short tail before switching, so a sync that
      // completes mid-frame doesn't look like an abrupt cut. The frame timer keeps ticking during
      // this wait -- only the *next* state switch is deferred, not the running animation.
      if (this.syncTailTimer) return; // tail already scheduled
      this.syncTailTimer = setTimeout(() => {
        this.syncTailTimer = null;
        this.currentState = null; // force the switch below to actually run once the tail elapses
        this.applyState(kind);
      }, SYNC_TAIL_MS);
      return;
    }

    this.currentState = kind;
    this.stopFrameTimer();

    const reducedMotion = this.prefersReducedMotion();

    if (kind === "syncing" && !reducedMotion) {
      this.frame = 1;
      this.setFrameImage(kind, this.frame);
      this.frameTimer = setInterval(() => {
        this.frame = nextFrame(this.frame, SYNC_FRAME_COUNT);
        this.setFrameImage(kind, this.frame);
      }, SYNC_FRAME_INTERVAL_MS);
      return;
    }

    if (kind === "starting" && !reducedMotion) {
      this.frame = 1;
      this.setFrameImage(kind, this.frame);
      this.frameTimer = setInterval(() => {
        if (this.frame >= START_FRAME_COUNT) {
          this.stopFrameTimer();
          this.setStaticImage("idle");
          return;
        }
        this.frame += 1;
        this.setFrameImage(kind, this.frame);
      }, START_FRAME_INTERVAL_MS);
      return;
    }

    // Static states (idle/off/problem), or any state under reduced motion -- no asset exists for a
    // "static syncing/starting" icon, so those fall back to the idle glyph instead.
    const staticKind = kind === "syncing" || kind === "starting" ? "idle" : kind;
    this.setStaticImage(staticKind);
  }

  private setFrameImage(kind: TrayStateKind, frame: number): void {
    this.tray.setImage(nativeImage.createFromPath(trayIconPath(this.options.assetsDir, kind, { frame })));
  }

  private setStaticImage(kind: TrayStateKind): void {
    const darkMode = process.platform === "darwin" && nativeTheme.shouldUseDarkColors;
    this.tray.setImage(nativeImage.createFromPath(trayIconPath(this.options.assetsDir, kind, { darkMode })));
  }

  private stopFrameTimer(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
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
    this.stopFrameTimer();
    if (this.syncTailTimer) clearTimeout(this.syncTailTimer);
    this.tray.destroy();
  }
}

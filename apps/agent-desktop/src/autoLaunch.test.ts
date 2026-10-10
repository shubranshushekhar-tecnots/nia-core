import { describe, expect, it, vi } from "vitest";
import { enableStartAtLoginByDefault, isStartAtLoginEnabled, setStartAtLogin, type LoginItemApi } from "./autoLaunch.js";

function fakeApp(openAtLogin: boolean): LoginItemApi {
  return {
    getLoginItemSettings: vi.fn(() => ({ openAtLogin })),
    setLoginItemSettings: vi.fn(),
  };
}

describe("isStartAtLoginEnabled", () => {
  it("reflects the current login item setting", () => {
    expect(isStartAtLoginEnabled(fakeApp(true))).toBe(true);
    expect(isStartAtLoginEnabled(fakeApp(false))).toBe(false);
  });
});

describe("enableStartAtLoginByDefault", () => {
  it("turns start-at-login on", () => {
    const app = fakeApp(false);
    enableStartAtLoginByDefault(app);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });
});

describe("setStartAtLogin", () => {
  it("can turn start-at-login off", () => {
    const app = fakeApp(true);
    setStartAtLogin(app, false);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });
});

import { describe, expect, it, vi } from "vitest";
import { handleSecondInstance, shouldQuitForSecondInstance, type FocusableWindow } from "./singleInstance.js";

function fakeWindow(overrides: Partial<Record<keyof FocusableWindow, boolean>> = {}): FocusableWindow {
  return {
    isDestroyed: vi.fn(() => overrides.isDestroyed ?? false),
    isMinimized: vi.fn(() => overrides.isMinimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe("shouldQuitForSecondInstance", () => {
  it("quits when the lock was NOT obtained (another instance is already running)", () => {
    expect(shouldQuitForSecondInstance(false)).toBe(true);
  });

  it("does not quit when the lock WAS obtained (this is the only/first instance)", () => {
    expect(shouldQuitForSecondInstance(true)).toBe(false);
  });
});

describe("handleSecondInstance", () => {
  it("shows and focuses a normal (not minimized) window", () => {
    const win = fakeWindow();
    handleSecondInstance(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("restores a minimized window before showing/focusing it", () => {
    const win = fakeWindow({ isMinimized: true });
    handleSecondInstance(win);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is no window reference (e.g. still starting up)", () => {
    expect(() => handleSecondInstance(null)).not.toThrow();
  });

  it("is a no-op when the window has already been destroyed", () => {
    const win = fakeWindow({ isDestroyed: true });
    handleSecondInstance(win);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("covers the relaunch-after-kill case: a fresh process always gets the lock once the old one is gone", () => {
    // The old process holding the lock (Task Manager kill, crash, PC restart) releases it at the OS
    // level the instant it exits -- there is no file/mutex left behind for a relaunch to trip over.
    // This is exactly what `shouldQuitForSecondInstance` reflects: a *fresh* app.requestSingleInstanceLock()
    // call after that process is gone always returns true (lock obtained), so this is simply
    // "shouldQuitForSecondInstance(true) === false" again, not a separate code path --
    // the lock itself is Electron/OS state, never app code's to simulate here.
    expect(shouldQuitForSecondInstance(true)).toBe(false);
  });
});

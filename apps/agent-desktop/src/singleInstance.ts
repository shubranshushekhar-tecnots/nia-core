/**
 * Single-instance + relaunch guarantee.
 *
 * `app.requestSingleInstanceLock()` is the only thing standing between "opening Nia Agent from the
 * Start Menu always opens the window" and the real customer bug this app must never repeat (fixed
 * in fe07ebc for the CLI/NSIS side -- a stale/invalid shortcut path silently did nothing). Electron's
 * lock is a live OS-level lock (a listening socket / named mutex depending on platform) tied to the
 * process, not a file left on disk -- so unlike a hand-rolled pidfile lock, it can never go stale and
 * block a relaunch after the previous instance was killed (Task Manager, crash, restart): the lock is
 * automatically released the instant that process exits, by the OS itself.
 *
 * This module holds only the pure decision logic so it's testable without a real Electron runtime;
 * main.ts wires it to the actual `app`/`BrowserWindow` APIs.
 */

/** `app.requestSingleInstanceLock()` returns `false` when another instance already holds the lock
 * (that other instance just received a "second-instance" event instead) -- this process must quit
 * immediately without creating a window, never fight over the lock. */
export function shouldQuitForSecondInstance(gotLock: boolean): boolean {
  return !gotLock;
}

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Runs in the *first* (lock-holding) instance's "second-instance" handler -- i.e. this is what makes
 * "opening Nia Agent again" from the Start Menu/Finder/dock focus the existing window instead of
 * doing nothing or erroring, no matter whether the window is currently hidden-to-tray, minimized, or
 * already focused.
 */
export function handleSecondInstance(win: FocusableWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

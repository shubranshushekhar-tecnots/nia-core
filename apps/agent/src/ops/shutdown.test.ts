import { afterEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "./shutdown.js";

describe("installGracefulShutdown", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it("aborts the controller on SIGINT and runs the callback once", () => {
    const controller = new AbortController();
    const onShutdown = vi.fn();
    uninstall = installGracefulShutdown(controller, onShutdown);

    process.emit("SIGINT");

    expect(controller.signal.aborted).toBe(true);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("ignores a second signal once already shutting down", () => {
    const controller = new AbortController();
    const onShutdown = vi.fn();
    uninstall = installGracefulShutdown(controller, onShutdown);

    process.emit("SIGINT");
    process.emit("SIGTERM");

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("stops listening once uninstalled", () => {
    const controller = new AbortController();
    const onShutdown = vi.fn();
    const uninstallNow = installGracefulShutdown(controller, onShutdown);
    uninstallNow();

    process.emit("SIGINT");

    expect(onShutdown).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});

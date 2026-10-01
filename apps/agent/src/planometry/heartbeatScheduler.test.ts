import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatScheduler } from "./heartbeatScheduler.js";

describe("HeartbeatScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after the interval with no activity", () => {
    const onHeartbeat = vi.fn();
    const scheduler = new HeartbeatScheduler(60_000, onHeartbeat);
    scheduler.start();

    vi.advanceTimersByTime(59_999);
    expect(onHeartbeat).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("resets the window on markActivity, delaying the next heartbeat", () => {
    const onHeartbeat = vi.fn();
    const scheduler = new HeartbeatScheduler(60_000, onHeartbeat);
    scheduler.start();

    vi.advanceTimersByTime(50_000);
    scheduler.markActivity();
    vi.advanceTimersByTime(50_000);
    expect(onHeartbeat).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("fires repeatedly on silence", () => {
    const onHeartbeat = vi.fn();
    const scheduler = new HeartbeatScheduler(60_000, onHeartbeat);
    scheduler.start();

    vi.advanceTimersByTime(180_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
  });

  it("stops firing after stop()", () => {
    const onHeartbeat = vi.fn();
    const scheduler = new HeartbeatScheduler(60_000, onHeartbeat);
    scheduler.start();
    scheduler.stop();

    vi.advanceTimersByTime(180_000);
    expect(onHeartbeat).not.toHaveBeenCalled();
  });
});

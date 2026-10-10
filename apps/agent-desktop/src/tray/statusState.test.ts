import { describe, expect, it } from "vitest";
import { mapStatusToConnectionState } from "./statusState.js";

describe("mapStatusToConnectionState", () => {
  it("maps a failed fetch (null) to off / service not running", () => {
    expect(mapStatusToConnectionState(null)).toEqual({
      kind: "off",
      label: "Not connected -- service isn't running",
    });
  });

  it("maps an unpaired agent to starting / not paired", () => {
    expect(mapStatusToConnectionState({ paired: false })).toEqual({
      kind: "starting",
      label: "Not paired yet",
    });
  });

  it("maps a paired, online, idle agent to idle with the platform URL", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true, platformUrl: "https://dev.niaconnector.com" })).toEqual({
      kind: "idle",
      label: "Connected to https://dev.niaconnector.com",
    });
  });

  it("maps a paired, online agent with no platformUrl to a plain idle label", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true })).toEqual({
      kind: "idle",
      label: "Connected",
    });
  });

  it("maps a paired, online agent with a job in flight to syncing", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true, isSyncing: true })).toEqual({
      kind: "syncing",
      label: "Connected",
    });
  });

  it("maps a revoked agent to problem regardless of online flag", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true, revoked: true })).toEqual({
      kind: "problem",
      label: "Access revoked -- re-pair this agent",
    });
  });

  it("maps a paired, offline (not revoked) agent to problem / connection problem", () => {
    expect(mapStatusToConnectionState({ paired: true, online: false })).toEqual({
      kind: "problem",
      label: "Connection problem",
    });
  });

  it("appends an 'update available' suffix to an idle label when a pending update is detected", () => {
    expect(
      mapStatusToConnectionState({ paired: true, online: true, pendingUpdate: { version: "2.0.0", readyToInstall: false } }),
    ).toEqual({
      kind: "idle",
      label: "Connected -- update 2.0.0 available",
    });
  });

  it("appends a 'ready to install' suffix to an idle label when the pending update is downloaded", () => {
    expect(
      mapStatusToConnectionState({
        paired: true,
        online: true,
        platformUrl: "https://dev.niaconnector.com",
        pendingUpdate: { version: "2.0.0", readyToInstall: true },
      }),
    ).toEqual({
      kind: "idle",
      label: "Connected to https://dev.niaconnector.com -- update 2.0.0 ready to install",
    });
  });

  it("appends the pending-update suffix even while syncing", () => {
    expect(
      mapStatusToConnectionState({
        paired: true,
        online: true,
        isSyncing: true,
        pendingUpdate: { version: "2.0.0", readyToInstall: false },
      }),
    ).toEqual({
      kind: "syncing",
      label: "Connected -- update 2.0.0 available",
    });
  });
});

import { describe, expect, it } from "vitest";
import { mapStatusToConnectionState } from "./statusState.js";

describe("mapStatusToConnectionState", () => {
  it("maps a failed fetch (null) to grey / service not running", () => {
    expect(mapStatusToConnectionState(null)).toEqual({
      color: "grey",
      label: "Not connected -- service isn't running",
    });
  });

  it("maps an unpaired agent to grey / not paired", () => {
    expect(mapStatusToConnectionState({ paired: false })).toEqual({
      color: "grey",
      label: "Not paired yet",
    });
  });

  it("maps a paired, online agent to green with the platform URL", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true, platformUrl: "https://dev.niaconnector.com" })).toEqual({
      color: "green",
      label: "Connected to https://dev.niaconnector.com",
    });
  });

  it("maps a paired, online agent with no platformUrl to a plain green label", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true })).toEqual({
      color: "green",
      label: "Connected",
    });
  });

  it("maps a revoked agent to amber regardless of online flag", () => {
    expect(mapStatusToConnectionState({ paired: true, online: true, revoked: true })).toEqual({
      color: "amber",
      label: "Access revoked -- re-pair this agent",
    });
  });

  it("maps a paired, offline (not revoked) agent to amber / connection problem", () => {
    expect(mapStatusToConnectionState({ paired: true, online: false })).toEqual({
      color: "amber",
      label: "Connection problem",
    });
  });
});

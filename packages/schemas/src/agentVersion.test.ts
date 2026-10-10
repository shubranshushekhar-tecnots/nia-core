import { describe, expect, it } from "vitest";
import { compareAgentVersions, isAgentVersionTooOld, isNewerVersion, MIN_AGENT_VERSION } from "./agentVersion.js";

describe("isAgentVersionTooOld", () => {
  it("flags a version older than the minimum", () => {
    expect(isAgentVersionTooOld("0.0.0", "0.0.1")).toBe(true);
    expect(isAgentVersionTooOld("0.9.0", "0.10.0")).toBe(true);
  });

  it("does not flag the minimum itself or anything newer", () => {
    expect(isAgentVersionTooOld(MIN_AGENT_VERSION, MIN_AGENT_VERSION)).toBe(false);
    expect(isAgentVersionTooOld("0.0.2", "0.0.1")).toBe(false);
    expect(isAgentVersionTooOld("1.0.0", "0.0.1")).toBe(false);
  });
});

describe("compareAgentVersions", () => {
  it("returns negative when a is older than b", () => {
    expect(compareAgentVersions("0.0.6", "0.0.7")).toBeLessThan(0);
    expect(compareAgentVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  it("returns zero for equal versions", () => {
    expect(compareAgentVersions("0.0.7", "0.0.7")).toBe(0);
  });

  it("returns positive when a is newer than b", () => {
    expect(compareAgentVersions("0.0.7", "0.0.6")).toBeGreaterThan(0);
    expect(compareAgentVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("treats unparseable segments as 0", () => {
    expect(compareAgentVersions("0.0.x", "0.0.0")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  it("flags a candidate strictly newer than current", () => {
    expect(isNewerVersion("0.0.7", "0.0.6")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
  });

  it("never flags an equal version as newer (no-op update)", () => {
    expect(isNewerVersion("0.0.6", "0.0.6")).toBe(false);
  });

  it("never flags an older candidate as newer (no downgrade)", () => {
    expect(isNewerVersion("0.0.5", "0.0.6")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isAgentVersionTooOld, MIN_AGENT_VERSION } from "./agentVersion.js";

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

import { describe, expect, it } from "vitest";
import { versionString } from "./versionCommand.js";
import { AGENT_VERSION } from "../generated/version.js";

describe("versionString", () => {
  it("includes the package version, node version, and platform", () => {
    const s = versionString();
    expect(s).toContain(AGENT_VERSION);
    expect(s).toContain(process.version);
    expect(s).toContain(process.platform);
  });

  it("matches a plain semver-ish version (no leading v, no build metadata)", () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

import { describe, expect, it } from "vitest";
import { consumeOtc, mintOtc } from "./otcStore.js";

describe("otcStore", () => {
  it("mints a code that can be consumed exactly once", () => {
    const code = mintOtc();
    expect(consumeOtc(code)).toBe(true);
    expect(consumeOtc(code)).toBe(false);
  });

  it("rejects a code that was never minted", () => {
    expect(consumeOtc("not-a-real-code")).toBe(false);
  });

  it("rejects a code once its 60s TTL has elapsed, even on first use", () => {
    const mintedAt = 1_000_000;
    const code = mintOtc(mintedAt);
    expect(consumeOtc(code, mintedAt + 60_000)).toBe(false);
  });

  it("accepts a code right up to (but not including) its expiry instant", () => {
    const mintedAt = 1_000_000;
    const code = mintOtc(mintedAt);
    expect(consumeOtc(code, mintedAt + 59_999)).toBe(true);
  });

  it("an expired code cannot be replayed later either -- it's deleted on the failed attempt", () => {
    const mintedAt = 1_000_000;
    const code = mintOtc(mintedAt);
    expect(consumeOtc(code, mintedAt + 60_000)).toBe(false);
    expect(consumeOtc(code, mintedAt + 60_001)).toBe(false);
  });
});

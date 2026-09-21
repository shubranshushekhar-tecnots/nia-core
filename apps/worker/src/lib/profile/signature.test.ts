import { describe, expect, it } from "vitest";
import { computeColumnStats } from "./stats.js";
import { computeProfileHash, computeSignature } from "./signature.js";

/**
 * Phase 10 Step 4 test 2 — profile_hash stability. Same-shape row
 * additions (more rows, same null/parse-bucket shape) must not change the
 * hash; a column gaining its first unparseable value (parse bucket
 * "all" -> "some") must.
 */
describe("computeProfileHash", () => {
  it("is unchanged when more same-shape rows are added", () => {
    const before = [computeColumnStats("amount", "varchar", ["1", "2", "3"])];
    const after = [computeColumnStats("amount", "varchar", ["1", "2", "3", "4", "5"])];

    const hashBefore = computeProfileHash(computeSignature(before));
    const hashAfter = computeProfileHash(computeSignature(after));

    expect(hashAfter).toBe(hashBefore);
  });

  it("changes when a column gains its first unparseable value", () => {
    const before = [computeColumnStats("amount", "varchar", ["1", "2", "3"])];
    const after = [computeColumnStats("amount", "varchar", ["1", "2", "not-a-number"])];

    const hashBefore = computeProfileHash(computeSignature(before));
    const hashAfter = computeProfileHash(computeSignature(after));

    expect(hashAfter).not.toBe(hashBefore);
  });

  it("is unchanged by null-count drift as long as null presence bucket (none/some/all) stays the same", () => {
    const before = [computeColumnStats("name", "varchar", ["a", null, "b"])];
    const after = [computeColumnStats("name", "varchar", ["a", null, "b", null, "c"])];

    const hashBefore = computeProfileHash(computeSignature(before));
    const hashAfter = computeProfileHash(computeSignature(after));

    expect(hashAfter).toBe(hashBefore);
  });
});

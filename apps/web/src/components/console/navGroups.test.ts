import { describe, expect, it } from "vitest";
import { buildNavGroups } from "./navGroups";

/**
 * Console redesign plan's Slice 10 — the Payments group is a documented
 * scope gap (see navGroups.ts's comment above PAYMENTS_GROUP): it's
 * wired up behind `paymentsEnabled`, but since no payments Console page
 * exists yet, it must never render a dead link, so it stays empty in
 * *either* flag state. This only needs to prove: (1) the group is absent
 * entirely when the flag is off (the default), and (2) even when the flag
 * is on, the group it appends has zero items.
 */
describe("buildNavGroups", () => {
  it("does not include a Payments group when paymentsEnabled is false", () => {
    const groups = buildNavGroups(false);
    expect(groups.some((g) => g.label === "Payments")).toBe(false);
  });

  it("includes an empty Payments group (no dead links) when paymentsEnabled is true", () => {
    const groups = buildNavGroups(true);
    const payments = groups.find((g) => g.label === "Payments");
    expect(payments).toBeDefined();
    expect(payments!.items).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import type { WriteGrant } from "@/lib/api/connectionsClient";
import { summarizeGrants } from "./grantsSummary";

function grant(overrides: Partial<WriteGrant>): WriteGrant {
  return {
    id: "g1",
    connectionId: "c1",
    grantedByUserId: "u1",
    scope: { schemas: ["public"] },
    grantedAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
    confirmedAt: null,
    credVersion: 1,
    writeCredentialVaultRef: null,
    writeRoleName: null,
    ...overrides,
  };
}

describe("summarizeGrants", () => {
  it("returns zero/empty for no grants", () => {
    expect(summarizeGrants([])).toEqual({ confirmedCount: 0, rows: [] });
  });

  it("counts only active-and-confirmed grants (revokedAt null, confirmedAt set) toward confirmedCount", () => {
    const grants = [
      grant({ id: "confirmed", confirmedAt: "2026-01-02T00:00:00Z" }),
      grant({ id: "pending" }),
      grant({ id: "revoked", confirmedAt: "2026-01-02T00:00:00Z", revokedAt: "2026-01-03T00:00:00Z" }),
    ];
    const { confirmedCount, rows } = summarizeGrants(grants);
    expect(confirmedCount).toBe(1);
    expect(rows.find((r) => r.id === "confirmed")?.status).toBe("confirmed");
    expect(rows.find((r) => r.id === "pending")?.status).toBe("pending");
    expect(rows.find((r) => r.id === "revoked")?.status).toBe("revoked");
  });

  it("derives namespaces from scope.schemas, falling back to an empty list when absent or malformed", () => {
    const grants = [
      grant({ id: "a", scope: { schemas: ["public", "sales"] } }),
      grant({ id: "b", scope: {} }),
      grant({ id: "c", scope: { schemas: "not-an-array" } }),
    ];
    const { rows } = summarizeGrants(grants);
    expect(rows.find((r) => r.id === "a")?.namespaces).toEqual(["public", "sales"]);
    expect(rows.find((r) => r.id === "b")?.namespaces).toEqual([]);
    expect(rows.find((r) => r.id === "c")?.namespaces).toEqual([]);
  });

  it("carries writeRoleName through unchanged", () => {
    const grants = [grant({ id: "a", writeRoleName: "nia_write_abc" })];
    expect(summarizeGrants(grants).rows[0]?.writeRoleName).toBe("nia_write_abc");
  });
});

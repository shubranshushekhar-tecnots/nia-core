import { describe, expect, it } from "vitest";
import { workspaceWhere } from "./workspaceScope.js";

describe("workspaceWhere", () => {
  it("produces an org_id fragment for an org scope", () => {
    const result = workspaceWhere({ orgId: "org-1" }, 1);
    expect(result).toEqual({ sql: "org_id = $1", params: ["org-1"] });
  });

  it("produces an org_id is null / owner_id fragment for a personal scope", () => {
    const result = workspaceWhere({ ownerId: "user-1" }, 2);
    expect(result).toEqual({ sql: "org_id is null and owner_id = $2", params: ["user-1"] });
  });

  it("positions the placeholder at the given paramIndex", () => {
    expect(workspaceWhere({ orgId: "org-1" }, 5).sql).toBe("org_id = $5");
  });

  it("throws on a non-positive paramIndex", () => {
    expect(() => workspaceWhere({ orgId: "org-1" }, 0)).toThrow(/paramIndex/);
    expect(() => workspaceWhere({ orgId: "org-1" }, -1)).toThrow(/paramIndex/);
  });

  it("throws on an empty orgId", () => {
    expect(() => workspaceWhere({ orgId: "" }, 1)).toThrow(/orgId/);
  });

  it("throws on an empty ownerId", () => {
    expect(() => workspaceWhere({ ownerId: "" }, 1)).toThrow(/ownerId/);
  });
});
